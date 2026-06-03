# Google Workspace MCP / MCP для Google Workspace

Local-first MCP server for Google Workspace. It includes tools for Google Drive, Docs, Sheets, Slides, Calendar, Tasks, Gmail, People, and Forms.

Локальный MCP-сервер для Google Workspace. Включает инструменты для Google Drive, Docs, Sheets, Slides, Calendar, Tasks, Gmail, People и Forms.

## What Is Included / Что внутри

- 230 MCP tools total / 230 MCP-инструментов всего
- Google Sheets: 42 tools / Google Таблицы: 42 инструмента
- Google Drive: 59 tools / Google Диск: 59 инструментов
- Gmail: 67 tools / Gmail: 67 инструментов
- Google Calendar: 39 tools / Google Календарь: 39 инструментов

## Local Setup / Локальная настройка

1. Install dependencies / Установить зависимости:

```bash
npm install
```

2. Create local env / Создать локальный env-файл:

```bash
cp .env.local.example .env.local
```

3. Fill `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in `.env.local`.

Заполните `GOOGLE_CLIENT_ID` и `GOOGLE_CLIENT_SECRET` в `.env.local`.

4. Add this OAuth redirect URI in Google Cloud Console / Добавьте этот OAuth redirect URI в Google Cloud Console:

```text
http://localhost:3001/oauth/callback
```

5. Run locally / Запустить локально:

```bash
set -a && source .env.local && set +a && npm run dev
```

6. Check health / Проверить health endpoint:

```bash
curl http://localhost:3001/health
```

## Tool Count / Подсчет инструментов

```bash
npm run tools:count
```

## Deploy Rule / Правило деплоя

Develop and build locally first. Deploy to VPS only after `npm run build` passes and tool count looks correct.

Сначала разрабатываем и собираем локально. На VPS деплоим только после успешного `npm run build` и проверки количества tools.
