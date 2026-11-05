/**
 * Alta de tickets. Reemplaza el workflow de n8n IUAhbDjd4N22fMLf.
 *
 * Desde el navegador solo se pueden llamar doGet, crearTicket y probarConfig.
 * El resto termina en _ para que google.script.run no las alcance: leerConfig_
 * devuelve el API token y no puede salir al cliente.
 *
 * Mapeo de nodos verificados en el canvas:
 * - Edit Fields.Email → solicitante. Reporter hace
 *   GET /rest/api/3/user/search?query=<email>
 * - Set technical.email → técnico, misma búsqueda. Si no hay usuario el nodo
 *   sigue (onError: continue) y el issue queda sin assignee.
 * - Limit → primer resultado. Si alguno trae el email exacto, se usa ese.
 * - Set Summary → resumen, como lo escribe el técnico.
 * - Set Category → problema, elegido de la lista de la planilla. Va en la
 *   descripción junto con el tipo de usuario. Si están
 *   JIRA_CATEGORY_FIELD_ID y JIRA_CATEGORY_FIELD_TYPE, el problema también
 *   va a ese campo.
 * - Duplicados → mismo solicitante y mismo resumen ya en estado Creado.
 *   If1, If2 y Filter no estaban en el export: un dato inválido o un
 *   solicitante que no existe en Jira corta el alta y se anota el motivo.
 * - Set reporter, Edit Fields1 y Create an issue → reporter y assignee por
 *   accountId. Proyecto y tipo salen de Script Properties: ese nodo no se
 *   exportó, así que no se inventan otros custom fields.
 * - Update row in sheet → una fila en la pestaña Log, con clave o error.
 */

var DEFAULTS = {
  JIRA_BASE: 'https://itti-digital.atlassian.net',
  SPREADSHEET_ID: '1j77bg03pQPwTRj3PJSRos0fG_mGUPIFyuGZWO7JZNmI',
  LOG_SHEET: 'Log'
};

var PROBLEMAS = [
  'Red',
  'VPN',
  'Cambio de equipo',
  'Reestablecimiento clave',
  'Prestamo',
  'Equipo',
  'Okta',
  'JC',
  'Instalación APP',
  'SALA DE REUNION'
];

var TIPOS_USUARIO = ['User', 'Vip'];

// El formulario muestra el apodo. El email es el que se busca en Jira.
// Si queda vacío, el alta de ese técnico se rechaza y no se crea el ticket.
var TECNICOS = [
  { nombre: 'Ale', email: 'alejandro.vazzano@itti.digital' },
  { nombre: 'Ari', email: 'ariel.martinez@itti.digital' },
  { nombre: 'Gus', email: 'gustavo.acosta@itti.digital' },
  { nombre: 'Mati', email: 'matias.allende@itti.digital' },
  { nombre: 'Sofi', email: 'sofia.bruno@itti.digital' },
  { nombre: 'Sofi Cuiñas', email: 'sofia.cuinas@itti.digital' },
  { nombre: 'Tomi', email: 'tomas.roldan@itti.digital' },
  { nombre: 'Valen', email: 'valentin.iglesias@itti.digital' }
];

var LOG_HEADERS = [
  'Fecha',
  'Solicitante',
  'AccountId solicitante',
  'Técnico',
  'AccountId técnico',
  'Resumen',
  'Categoría',
  'Detalle',
  'Estado',
  'Clave',
  'URL',
  'Resultado',
  'Tipo de usuario'
];

var COL = {
  solicitante: 1,
  resumen: 5,
  estado: 8,
  clave: 9,
  url: 10
};

function doGet() {
  var template = HtmlService.createTemplateFromFile('Index');
  template.spreadsheetUrl = urlPlanilla_();
  template.catalogoJson = jsonSeguro_(catalogoPublico_());
  return template.evaluate()
    .setTitle('Alta de tickets')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

/**
 * Punto de entrada del formulario. Devuelve siempre un objeto para la UI
 * y deja una fila en Log, salvo que ni siquiera se pueda leer la config.
 */
function crearTicket(form) {
  var config;
  try {
    config = leerConfig_();
  } catch (error) {
    return respuesta_(false, 'Error', '', '', mensajeDe_(error));
  }

  var datos;
  try {
    datos = validarFormulario_(form);
  } catch (error) {
    var mensaje = mensajeDe_(error);
    anotarSeguro_(config, borrador_(form), { estado: 'Error', resultado: mensaje });
    return respuesta_(false, 'Error', '', '', mensaje);
  }

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) {
    return respuesta_(false, 'Error', '', '', 'Hay otra alta en curso. Intentá de nuevo en unos segundos.');
  }

  try {
    return crearTicketBloqueado_(config, datos);
  } catch (error) {
    var fallo = mensajeDe_(error);
    anotarSeguro_(config, datos, { estado: 'Error', resultado: fallo });
    return respuesta_(false, 'Error', '', '', fallo);
  } finally {
    lock.releaseLock();
  }
}

/**
 * Revisa credenciales y la planilla sin crear un ticket.
 * Ejecutar desde el editor de Apps Script. No devuelve el token.
 */
function probarConfig() {
  var config = leerConfig_();
  var ss = SpreadsheetApp.openById(config.spreadsheetId);
  var me = jira_(config, '/rest/api/3/myself', { method: 'get' });
  if (!me.ok) {
    throw new Error(me.mensaje);
  }
  var resumen = {
    jira: me.data.displayName || me.data.emailAddress || 'ok',
    base: config.base,
    planilla: ss.getName(),
    proyecto: config.projectKey,
    tipo: config.issueType,
    log: config.logSheet
  };
  console.log(JSON.stringify(resumen));
  return resumen;
}

function crearTicketBloqueado_(config, datos) {
  var sheet = obtenerHojaLog_(config);
  var duplicado = buscarDuplicado_(sheet, datos.email, datos.resumen);
  if (duplicado) {
    var textoDuplicado = 'Ya existe un ticket con este solicitante y este resumen: ' + duplicado.clave + '.';
    registrar_(sheet, datos, {
      estado: 'Duplicado',
      clave: duplicado.clave,
      url: duplicado.url,
      resultado: textoDuplicado
    });
    return respuesta_(false, 'Duplicado', duplicado.clave, duplicado.url, textoDuplicado);
  }

  var reporter = buscarUsuario_(config, datos.email);
  if (!reporter) {
    var textoReporter = 'No se encontró al solicitante en Jira: ' + datos.email + '.';
    registrar_(sheet, datos, { estado: 'Error', resultado: textoReporter });
    return respuesta_(false, 'Error', '', '', textoReporter);
  }

  var tecnico = null;
  var avisoTecnico = '';
  try {
    tecnico = buscarUsuario_(config, datos.emailTecnico);
    if (!tecnico) {
      avisoTecnico = 'No se encontró al técnico en Jira (' + datos.emailTecnico + '). El ticket se crea sin asignar.';
    }
  } catch (error) {
    if (esErrorDeCredencial_(error)) throw error;
    avisoTecnico = 'No se pudo buscar al técnico (' + mensajeDe_(error) + '). El ticket se crea sin asignar.';
  }

  var creado = crearIssue_(config, armarIssue_(config, datos, reporter, tecnico));
  var url = config.base + '/browse/' + creado.key;
  var avisos = [avisoTecnico, creado.aviso].filter(Boolean).join(' ');
  var resultadoTexto = ('Se creó ' + creado.key + '.' + (avisos ? ' ' + avisos : '')).trim();

  var avisoLog = '';
  try {
    registrar_(sheet, datos, {
      estado: 'Creado',
      accountSolicitante: reporter.accountId,
      accountTecnico: tecnico ? tecnico.accountId : '',
      clave: creado.key,
      url: url,
      resultado: resultadoTexto
    });
  } catch (error) {
    avisoLog = ' El ticket existe, pero no se pudo escribir la planilla: ' + mensajeDe_(error);
    console.error(avisoLog);
  }

  return respuesta_(true, 'Creado', creado.key, url, resultadoTexto + avisoLog);
}

function validarFormulario_(form) {
  var fuente = form || {};
  var email = normalizarEmail_(fuente.email);
  var problema = opcionCatalogo_(PROBLEMAS, fuente.problema);
  var tipoUsuario = opcionCatalogo_(TIPOS_USUARIO, fuente.tipoUsuario);
  var tecnico = buscarTecnico_(fuente.tecnico);
  var resumen = limpiar_(fuente.resumen);
  var detalle = limpiar_(fuente.detalle);

  if (!emailValido_(email)) {
    throw new Error('El email del solicitante no es válido.');
  }
  if (!problema) {
    throw new Error('Elegí un problema de la lista.');
  }
  if (!tecnico) {
    throw new Error('Elegí un técnico de la lista.');
  }
  if (!emailValido_(tecnico.email)) {
    throw new Error('Falta el email de Jira de ' + tecnico.nombre + '. Completalo en el catálogo de técnicos.');
  }
  if (!tipoUsuario) {
    throw new Error('Elegí el tipo de usuario.');
  }
  if (!resumen) {
    throw new Error('El resumen es obligatorio.');
  }
  if (resumen.length > 255) {
    throw new Error('El resumen no puede pasar de 255 caracteres.');
  }
  if (detalle.length > 10000) {
    throw new Error('El detalle es demasiado largo.');
  }

  return {
    email: email,
    tecnico: tecnico.nombre,
    emailTecnico: normalizarEmail_(tecnico.email),
    resumen: resumen,
    problema: problema,
    categoria: problema,
    tipoUsuario: tipoUsuario,
    detalle: detalle
  };
}

/**
 * Payload de POST /rest/api/3/issue.
 * Proyecto, tipo y el campo de categoría son configuración: el nodo
 * Create an issue no se exportó.
 */
function armarIssue_(config, datos, reporter, tecnico) {
  var lineas = [];
  if (datos.detalle) lineas.push(datos.detalle);
  lineas.push('Problema: ' + datos.problema);
  lineas.push('Tipo de usuario: ' + datos.tipoUsuario);
  lineas.push('Solicitante: ' + datos.email);
  lineas.push('Técnico: ' + (datos.tecnico || datos.emailTecnico));

  var fields = {
    project: { key: config.projectKey },
    issuetype: { name: config.issueType },
    summary: datos.resumen,
    description: adf_(lineas),
    reporter: { id: reporter.accountId }
  };

  if (tecnico && tecnico.accountId) {
    fields.assignee = { id: tecnico.accountId };
  }

  if (config.categoryFieldId && config.categoryFieldType === 'text') {
    fields[config.categoryFieldId] = datos.problema;
  } else if (config.categoryFieldId && config.categoryFieldType === 'option') {
    fields[config.categoryFieldId] = { value: datos.problema };
  }

  return fields;
}

function crearIssue_(config, fields) {
  var primero = jira_(config, '/rest/api/3/issue', {
    method: 'post',
    payload: { fields: fields }
  });
  if (primero.ok) {
    return { key: primero.data.key, aviso: '' };
  }

  var errors = primero.errors;
  var reintento = clonar_(fields);
  var avisos = [];
  if (errors.reporter) {
    delete reintento.reporter;
    avisos.push('Jira no dejó poner al solicitante como reporter.');
  }
  if (errors.assignee) {
    delete reintento.assignee;
    avisos.push('Jira no dejó asignar al técnico.');
  }
  if (!avisos.length) {
    throw new Error(primero.mensaje);
  }

  var segundo = jira_(config, '/rest/api/3/issue', {
    method: 'post',
    payload: { fields: reintento }
  });
  if (!segundo.ok) {
    throw new Error(segundo.mensaje);
  }
  return { key: segundo.data.key, aviso: avisos.join(' ') };
}

/**
 * Nodos Reporter y Technician.
 * GET /rest/api/3/user/search?query=<email>
 * Null si Jira responde sin usuarios.
 */
function buscarUsuario_(config, email) {
  var data = jira_(config, '/rest/api/3/user/search?query=' + encodeURIComponent(email), {
    method: 'get'
  });
  if (!data.ok) {
    throw new Error(data.mensaje);
  }
  var usuarios = data.data || [];
  if (!usuarios.length) return null;

  var needle = email.toLowerCase();
  for (var i = 0; i < usuarios.length; i++) {
    if (String(usuarios[i].emailAddress || '').toLowerCase() === needle) {
      return usuarios[i];
    }
  }
  return usuarios[0];
}

function buscarDuplicado_(sheet, email, resumen) {
  var values = sheet.getDataRange().getValues();
  var resumenNorm = normalizarTexto_(resumen);
  for (var i = 1; i < values.length; i++) {
    if (String(values[i][COL.estado] || '') !== 'Creado') continue;
    if (normalizarEmail_(values[i][COL.solicitante]) !== email) continue;
    if (normalizarTexto_(values[i][COL.resumen]) !== resumenNorm) continue;
    var clave = String(values[i][COL.clave] || '');
    if (!clave) continue;
    return {
      clave: clave,
      url: String(values[i][COL.url] || '')
    };
  }
  return null;
}

function obtenerHojaLog_(config) {
  var ss = SpreadsheetApp.openById(config.spreadsheetId);
  var sheet = ss.getSheetByName(config.logSheet);
  if (!sheet) {
    sheet = ss.insertSheet(config.logSheet, ss.getNumSheets());
  }
  if (sheet.getMaxColumns() < LOG_HEADERS.length) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), LOG_HEADERS.length - sheet.getMaxColumns());
  }
  var ancho = LOG_HEADERS.length;
  var primera = sheet.getRange(1, 1, 1, ancho).getValues()[0];
  if (primera.join('') === '') {
    sheet.getRange(1, 1, 1, ancho).setValues([LOG_HEADERS]);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, ancho).setFontWeight('bold');
  } else if (!limpiar_(primera[ancho - 1])) {
    sheet.getRange(1, ancho).setValue(LOG_HEADERS[ancho - 1]).setFontWeight('bold');
  }
  return sheet;
}

function registrar_(sheet, datos, extra) {
  var tz = sheet.getParent().getSpreadsheetTimeZone() || Session.getScriptTimeZone();
  sheet.appendRow([
    Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd HH:mm:ss'),
    limpiar_(datos.email),
    extra.accountSolicitante || '',
    limpiar_(datos.tecnico || datos.emailTecnico),
    extra.accountTecnico || '',
    limpiar_(datos.resumen),
    limpiar_(datos.problema || datos.categoria),
    limpiar_(datos.detalle),
    extra.estado || '',
    extra.clave || '',
    extra.url || '',
    extra.resultado || '',
    limpiar_(datos.tipoUsuario)
  ]);
}

function anotarSeguro_(config, datos, extra) {
  try {
    registrar_(obtenerHojaLog_(config), datos || {}, extra || {});
  } catch (error) {
    console.error('No se pudo escribir el log: ' + mensajeDe_(error));
  }
}

function jira_(config, path, opciones) {
  var params = {
    method: (opciones.method || 'get').toLowerCase(),
    headers: {
      Authorization: autorizacion_(config),
      Accept: 'application/json'
    },
    muteHttpExceptions: true
  };
  if (opciones.payload) {
    params.contentType = 'application/json';
    params.payload = JSON.stringify(opciones.payload);
  }

  var respuestaHttp = UrlFetchApp.fetch(config.base + path, params);
  var code = respuestaHttp.getResponseCode();
  var texto = respuestaHttp.getContentText() || '';
  var data = null;
  if (texto) {
    try {
      data = JSON.parse(texto);
    } catch (error) {
      data = null;
    }
  }

  if (code >= 200 && code < 300) {
    return { ok: true, data: data, errors: {}, mensaje: '' };
  }

  return {
    ok: false,
    data: data,
    errors: (data && data.errors) || {},
    mensaje: mensajeJira_(code, data, texto)
  };
}

function leerConfig_() {
  var stored = PropertiesService.getScriptProperties().getProperties();
  var email = limpiar_(stored.JIRA_EMAIL);
  var token = stored.JIRA_API_TOKEN || '';
  var projectKey = limpiar_(stored.JIRA_PROJECT_KEY).toUpperCase();
  var issueType = limpiar_(stored.JIRA_ISSUE_TYPE);
  var categoryFieldId = limpiar_(stored.JIRA_CATEGORY_FIELD_ID);
  var categoryFieldType = limpiar_(stored.JIRA_CATEGORY_FIELD_TYPE).toLowerCase();

  var missing = [];
  if (!email) missing.push('JIRA_EMAIL');
  if (!token) missing.push('JIRA_API_TOKEN');
  if (!projectKey) missing.push('JIRA_PROJECT_KEY');
  if (!issueType) missing.push('JIRA_ISSUE_TYPE');
  if (missing.length) {
    throw new Error('Faltan Script Properties: ' + missing.join(', ') + '.');
  }
  if (categoryFieldId && categoryFieldType !== 'text' && categoryFieldType !== 'option') {
    throw new Error('JIRA_CATEGORY_FIELD_TYPE tiene que ser text u option.');
  }

  return {
    base: String(stored.JIRA_BASE || DEFAULTS.JIRA_BASE).replace(/\/$/, ''),
    email: email,
    token: token,
    spreadsheetId: limpiar_(stored.SPREADSHEET_ID) || DEFAULTS.SPREADSHEET_ID,
    projectKey: projectKey,
    issueType: issueType,
    categoryFieldId: categoryFieldId,
    categoryFieldType: categoryFieldType,
    logSheet: limpiar_(stored.LOG_SHEET) || DEFAULTS.LOG_SHEET
  };
}

function urlPlanilla_() {
  var stored = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  var id = limpiar_(stored) || DEFAULTS.SPREADSHEET_ID;
  return 'https://docs.google.com/spreadsheets/d/' + id + '/edit';
}

function borrador_(form) {
  var fuente = form || {};
  var tecnico = buscarTecnico_(fuente.tecnico);
  var problema = limpiar_(fuente.problema);
  return {
    email: normalizarEmail_(fuente.email),
    tecnico: tecnico ? tecnico.nombre : limpiar_(fuente.tecnico),
    emailTecnico: tecnico ? tecnico.email : '',
    resumen: limpiar_(fuente.resumen),
    problema: problema,
    categoria: problema,
    tipoUsuario: limpiar_(fuente.tipoUsuario),
    detalle: limpiar_(fuente.detalle)
  };
}

function catalogoPublico_() {
  return {
    problemas: PROBLEMAS,
    tipos: TIPOS_USUARIO,
    tecnicos: TECNICOS.map(function (tecnico) {
      return tecnico.nombre;
    })
  };
}

function opcionCatalogo_(opciones, valor) {
  var i;
  for (i = 0; i < opciones.length; i++) {
    if (normalizarTexto_(opciones[i]) === normalizarTexto_(valor)) return opciones[i];
  }
  return '';
}

function buscarTecnico_(valor) {
  var i;
  for (i = 0; i < TECNICOS.length; i++) {
    if (normalizarTexto_(TECNICOS[i].nombre) === normalizarTexto_(valor)) return TECNICOS[i];
  }
  return null;
}

function jsonSeguro_(valor) {
  return JSON.stringify(valor).replace(/</g, '\\u003c');
}

function autorizacion_(config) {
  var token = Utilities.base64Encode(config.email + ':' + config.token, Utilities.Charset.UTF_8);
  return 'Basic ' + String(token).replace(/[\r\n]/g, '');
}

function adf_(lineas) {
  return {
    type: 'doc',
    version: 1,
    content: lineas.filter(Boolean).map(function (texto) {
      return {
        type: 'paragraph',
        content: [{ type: 'text', text: String(texto) }]
      };
    })
  };
}

function respuesta_(ok, estado, clave, url, mensaje) {
  return {
    ok: ok,
    estado: estado,
    clave: clave || '',
    url: url || '',
    mensaje: mensaje || ''
  };
}

function mensajeJira_(code, data, texto) {
  if (data && data.errorMessages && data.errorMessages.length) {
    return data.errorMessages.join(' ');
  }
  if (data && data.errors) {
    var partes = Object.keys(data.errors).map(function (clave) {
      return clave + ': ' + data.errors[clave];
    });
    if (partes.length) return partes.join(' ');
  }
  if (code === 401 || code === 403) {
    return 'Jira rechazó la credencial (' + code + '). Revisá JIRA_EMAIL y JIRA_API_TOKEN.';
  }
  var recorte = String(texto || '').slice(0, 300);
  return recorte ? ('Jira respondió ' + code + ': ' + recorte) : ('Jira respondió ' + code + '.');
}

function esErrorDeCredencial_(error) {
  return /401|403|credencial/i.test(mensajeDe_(error));
}

function mensajeDe_(error) {
  if (!error) return 'Error desconocido.';
  return String(error.message || error);
}

function emailValido_(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function normalizarEmail_(valor) {
  return limpiar_(valor).toLowerCase();
}

function normalizarTexto_(valor) {
  return limpiar_(valor).toLowerCase().replace(/\s+/g, ' ');
}

function limpiar_(valor) {
  return String(valor == null ? '' : valor).trim();
}

function clonar_(objeto) {
  var copia = {};
  Object.keys(objeto).forEach(function (clave) {
    copia[clave] = objeto[clave];
  });
  return copia;
}
