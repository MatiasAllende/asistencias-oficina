# Alta de tickets

Web App de Google Apps Script. El técnico completa un formulario, el script busca al solicitante y al técnico en Jira, crea el issue y anota el resultado en una planilla.

El historial se escribe en una pestaña `Log` de la planilla configurada en `SPREADSHEET_ID`.

## Qué hace cada paso

Equivalente a los nodos que se pudieron verificar:

1. Valida emails, resumen (máximo 255) y categoría. El detalle es opcional.
2. Si ya hay una fila `Creado` con el mismo solicitante y el mismo resumen, no abre otro issue. Esa es la regla del nodo Duplicados hasta tener el JSON del workflow: If1, If2 y Filter no estaban en el export.
3. `GET {JIRA_BASE}/rest/api/3/user/search?query=<email>` para el solicitante. Sin usuario, corta y lo anota en `Log`.
4. La misma búsqueda para el técnico (nodo Technician). Ese nodo sigue aunque falle: si no hay usuario, el issue se crea sin assignee.
5. `POST /rest/api/3/issue` con reporter y assignee en `accountId`. Si Jira rechaza solo esos campos por permisos, reintenta sin ellos y lo aclara en el resultado.
6. Agrega una fila en `Log` con la clave, la URL o el error.

La categoría siempre va en la descripción. No se manda un custom field salvo que lo configures, porque el nodo Create an issue no se exportó.

## Script Properties

En el proyecto de Apps Script: Configuración del proyecto → Propiedades del script. El token no va en el código ni en git.

Obligatorias:

- `JIRA_EMAIL`: email de la cuenta de Atlassian que crea los tickets.
- `JIRA_API_TOKEN`: API token de esa cuenta. Permisos para buscar usuarios y crear issues. Asignar y modificar reporter hacen falta si querés que esos campos queden puestos; si faltan, el alta igual sigue y lo deja escrito en `Log`.
- `JIRA_BASE`: sitio de Jira, por ejemplo `https://tu-empresa.atlassian.net`.
- `SPREADSHEET_ID`: id de la planilla donde se escribe el historial.
- `JIRA_PROJECT_KEY`: clave del proyecto, por ejemplo `SD`.
- `JIRA_ISSUE_TYPE`: nombre del tipo de issue, tal como figura en Jira (por ejemplo `Task` o `Service Request`).

Opcionales:

- `LOG_SHEET`: por defecto `Log`.
- `JIRA_CATEGORY_FIELD_ID` y `JIRA_CATEGORY_FIELD_TYPE`: los dos juntos. El tipo es `text` o `option` (lista de Jira, se envía `{ value: categoria }`). Si no están, la categoría queda solo en la descripción.

La planilla tiene que estar compartida como editor con la cuenta que publica el Web App. Quien usa el formulario no necesita acceso a la planilla: el script corre como el publicador.

## Publicar

```bash
npm install -g @google/clasp
clasp login
cp .clasp.json.example .clasp.json
clasp create --title "Alta de tickets" --type webapp --rootDir .
clasp push
```

Si `clasp create` ofrece reemplazar `appsscript.json`, conservá el del repo. Si el proyecto de Apps Script ya existe, pegá su Script ID en `.clasp.json` y corré solo `clasp push`.

Después, en el editor de Apps Script:

1. Ejecutá `probarConfig` una vez y aceptá los permisos. En el registro tiene que aparecer el usuario de Jira y el nombre de la planilla. No crea tickets.
2. Implementar → Nueva implementación → Aplicación web.
3. Ejecutar como: yo. Quién tiene acceso: solo usuarios del dominio de la cuenta con la que publicaste (por ejemplo la de la UTN).
4. Copiá la URL del Web App.

Cada cambio de código necesita `clasp push` y una implementación nueva (o "Administrar implementaciones" → editar) para que la URL publicada lo tome.

La cuenta dueña es la que usa `clasp login`. Puede ser la de la UTN. En esa cuenta tiene que estar activada la API de Apps Script en [script.google.com/home/usersettings](https://script.google.com/home/usersettings). La planilla tiene que estar compartida como editor con esa misma cuenta.

Los técnicos del formulario se editan en `TECNICOS`, dentro de `Code.gs`: cada uno tiene `nombre` y `email` de Jira.

## Columnas de Log

`Fecha`, `Solicitante`, `AccountId solicitante`, `Técnico`, `AccountId técnico`, `Resumen`, `Categoría`, `Detalle`, `Estado`, `Clave`, `URL`, `Resultado`.

`Estado` es `Creado`, `Duplicado` o `Error`. Solo `Creado` bloquea un alta repetida.

Si `Log` no existe, el script la crea al final de la planilla. Si ya existe y la primera fila está vacía, escribe esos encabezados. Si la primera fila ya tiene algo, no la pisa y agrega las filas abajo.
