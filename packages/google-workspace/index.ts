/**
 * Google Drive MCP Server — VPS Edition
 * Transport: Streamable HTTP with OAuth discovery compatible with Claude remote connectors.
 *
 * Architecture:
 * - Claude authenticates directly against Google OAuth using the user's provided client ID/secret.
 * - This MCP server advertises OAuth Protected Resource Metadata per MCP auth spec.
 * - The server accepts Google Bearer access tokens and uses them directly with Google APIs.
 * - Optional manual OAuth helpers (/oauth/start, /oauth/callback) remain available for debugging.
 */

import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { google } from "googleapis";
import { OAuth2Client } from "google-auth-library";
import { z } from "zod";
import { mcpAuthMetadataRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { randomBytes } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";

// ─── Config ─────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || "3001", 10);
const HOST = process.env.HOST || "0.0.0.0";
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID!;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET!;
const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || `http://localhost:${PORT}/oauth/callback`;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("❌ Missing env vars: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET");
  process.exit(1);
}

const SCOPES = [
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/presentations",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/tasks",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.settings.basic",
  "https://www.googleapis.com/auth/gmail.settings.sharing",
  "https://www.googleapis.com/auth/contacts.readonly",
  "https://www.googleapis.com/auth/forms.body",
  "https://www.googleapis.com/auth/forms.responses.readonly",
];

const GOOGLE_ISSUER = "https://accounts.google.com";
const GOOGLE_AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOCATION_ENDPOINT = "https://oauth2.googleapis.com/revoke";
const TOKEN_INFO_ENDPOINT = "https://oauth2.googleapis.com/tokeninfo";

function derivePublicPrefixFromRedirectUri(redirectUri: string): string {
  try {
    const u = new URL(redirectUri);
    return u.pathname.replace(/\/oauth\/callback$/, "") || "";
  } catch {
    return "";
  }
}

const PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN || (() => {
  try {
    return new URL(REDIRECT_URI).origin;
  } catch {
    return `http://localhost:${PORT}`;
  }
})();

const PUBLIC_PREFIX = (() => {
  const raw = process.env.PUBLIC_PATH_PREFIX || derivePublicPrefixFromRedirectUri(REDIRECT_URI);
  if (!raw || raw === "/") return "";
  return raw.startsWith("/") ? raw : `/${raw}`;
})();

const PUBLIC_MCP_URL = new URL(`${PUBLIC_PREFIX}/mcp`, PUBLIC_ORIGIN);
const RESOURCE_METADATA_URL = getOAuthProtectedResourceMetadataUrl(PUBLIC_MCP_URL);
const AUTH_ISSUER = new URL(PUBLIC_PREFIX || "/", PUBLIC_ORIGIN).href.replace(/\/$/, "");

type ConnectorCodeEntry = {
  tokens: any;
  redirectUri: string;
  scope: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
};

type ConnectorTokenEntry = {
  tokens: any;
  scope: string;
  connectorRefreshToken: string;
  createdAt: number;
  updatedAt: number;
};

type PersistedTokenStore = {
  accessTokens?: Record<string, ConnectorTokenEntry>;
  refreshTokens?: Record<string, string>;
};

const TOKEN_FILE = process.env.TOKEN_FILE || "/data/tokens.json";
const codeStore = new Map<string, ConnectorCodeEntry>();

function loadPersistedTokens(): {
  tokenStore: Map<string, ConnectorTokenEntry>;
  refreshTokenStore: Map<string, string>;
} {
  try {
    if (existsSync(TOKEN_FILE)) {
      const data = JSON.parse(readFileSync(TOKEN_FILE, "utf8")) as PersistedTokenStore;
      return {
        tokenStore: new Map(Object.entries(data.accessTokens || {})),
        refreshTokenStore: new Map(Object.entries(data.refreshTokens || {})),
      };
    }
  } catch (err) {
    console.error("Failed to load connector tokens:", err);
  }

  return {
    tokenStore: new Map(),
    refreshTokenStore: new Map(),
  };
}

function savePersistedTokens() {
  try {
    const dir = TOKEN_FILE.split("/").slice(0, -1).join("/");
    if (dir) mkdirSync(dir, { recursive: true });
    const data: PersistedTokenStore = {
      accessTokens: Object.fromEntries(tokenStore),
      refreshTokens: Object.fromEntries(refreshTokenStore),
    };
    writeFileSync(TOKEN_FILE, JSON.stringify(data, null, 2), "utf8");
  } catch (err) {
    console.error("Failed to save connector tokens:", err);
  }
}

const persistedTokens = loadPersistedTokens();
const tokenStore = persistedTokens.tokenStore;
const refreshTokenStore = persistedTokens.refreshTokenStore;
const randomId = () => randomBytes(24).toString("base64url");
const encodeState = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const decodeState = (value: string) => JSON.parse(Buffer.from(value, "base64url").toString("utf8"));

const GOOGLE_OAUTH_METADATA = {
  issuer: AUTH_ISSUER,
  authorization_endpoint: `${AUTH_ISSUER}/oauth/authorize`,
  token_endpoint: `${AUTH_ISSUER}/oauth/token`,
  registration_endpoint: `${AUTH_ISSUER}/oauth/register`,
  revocation_endpoint: `${AUTH_ISSUER}/oauth/revoke`,
  response_types_supported: ["code"],
  grant_types_supported: ["authorization_code", "refresh_token"],
  code_challenge_methods_supported: ["S256"],
  token_endpoint_auth_methods_supported: ["none"],
  scopes_supported: SCOPES,
};

// ─── OAuth helper ────────────────────────────────────────────────────────────
function createOAuthClient(): OAuth2Client {
  return new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
}

function getAccessTokenFromRequest(req: express.Request): string | null {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7).trim();
  return token || null;
}

async function verifyGoogleAccessToken(token: string): Promise<AuthInfo> {
  const stored = tokenStore.get(token);
  if (!stored) {
    throw new Error("Unknown connector token");
  }

  const scopeValue = typeof stored.scope === "string" && stored.scope ? stored.scope : SCOPES.join(" ");
  const scopes = scopeValue.split(" ").map((scopeName: string) => scopeName.trim()).filter(Boolean);
  return {
    token,
    clientId: "google-workspace-user",
    scopes,
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    resource: PUBLIC_MCP_URL,
    extra: { issuer: AUTH_ISSUER },
  };
}

// ─── MCP Server factory ──────────────────────────────────────────────────────
function createDriveMcpServer(auth: OAuth2Client): McpServer {
  const server = new McpServer({
    name: "google-workspace-mcp",
    version: "1.8.0",
  });

  const drive = google.drive({ version: "v3", auth });
  const docs = google.docs({ version: "v1", auth });
  const sheets = google.sheets({ version: "v4", auth });
  const slides = google.slides({ version: "v1", auth });
  const calendar = google.calendar({ version: "v3", auth });
  const tasks = google.tasks({ version: "v1", auth });
  const gmail = google.gmail({ version: "v1", auth });
  const people = google.people({ version: "v1", auth });
  const forms = google.forms({ version: "v1", auth });
  const driveAny = drive as any;
  const gmailAny = gmail as any;

  const asText = (value: unknown) => ({
    content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
  });

  const decodeBase64Url = (input?: string | null): string => {
    if (!input) return "";
    const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
    return Buffer.from(normalized, "base64").toString("utf8");
  };

  const encodeBase64Url = (input: Buffer | string): string =>
    Buffer.isBuffer(input) ? input.toString("base64url") : Buffer.from(input).toString("base64url");

  const extractGmailBody = (payload?: any): string => {
    if (!payload) return "";
    if (payload.body?.data) return decodeBase64Url(payload.body.data);
    if (Array.isArray(payload.parts)) {
      for (const part of payload.parts) {
        const mimeType = part.mimeType || "";
        if (mimeType === "text/plain" && part.body?.data) {
          return decodeBase64Url(part.body.data);
        }
      }
      for (const part of payload.parts) {
        const nested = extractGmailBody(part);
        if (nested) return nested;
      }
    }
    return "";
  };

  const extractGmailHeaders = (payload?: any): Record<string, string> => {
    const headers: Record<string, string> = {};
    for (const h of payload?.headers ?? []) {
      if (h?.name) headers[h.name.toLowerCase()] = h.value ?? "";
    }
    return headers;
  };

  const listGmailAttachments = (payload?: any, path = "root"): Array<Record<string, unknown>> => {
    const out: Array<Record<string, unknown>> = [];
    const walk = (part: any, currentPath: string) => {
      if (!part) return;
      const attachmentId = part.body?.attachmentId;
      const filename = part.filename || "";
      if (attachmentId || filename) {
        out.push({
          path: currentPath,
          filename,
          mimeType: part.mimeType || "",
          attachmentId: attachmentId || null,
          size: part.body?.size || 0,
          inline: (part.headers ?? []).some((h: any) => String(h?.name || "").toLowerCase() === "content-id"),
        });
      }
      for (const [idx, child] of (part.parts ?? []).entries()) {
        walk(child, `${currentPath}.${idx}`);
      }
    };
    walk(payload, path);
    return out;
  };

  const getDriveExportMime = (mimeType: string, exportFormat: string): string | null => {
    const docsMap: Record<string, string> = {
      text: "text/plain",
      markdown: "text/markdown",
      html: "text/html",
      pdf: "application/pdf",
      docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    };
    const sheetsMap: Record<string, string> = {
      csv: "text/csv",
      xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      pdf: "application/pdf",
    };
    const slidesMap: Record<string, string> = {
      txt: "text/plain",
      pdf: "application/pdf",
      pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    };

    if (mimeType === "application/vnd.google-apps.document") return docsMap[exportFormat] || null;
    if (mimeType === "application/vnd.google-apps.spreadsheet") return sheetsMap[exportFormat] || null;
    if (mimeType === "application/vnd.google-apps.presentation") return slidesMap[exportFormat] || null;
    return null;
  };

  const buildMimeMessage = ({
    to,
    subject,
    body,
    cc,
    bcc,
    attachments,
    inReplyTo,
    references,
  }: {
    to: string;
    subject: string;
    body: string;
    cc?: string;
    bcc?: string;
    attachments?: Array<{ filename: string; mime_type?: string; content_base64: string }>;
    inReplyTo?: string;
    references?: string;
  }): string => {
    const safeAttachments = attachments ?? [];
    if (!safeAttachments.length) {
      return [
        `To: ${to}`,
        cc ? `Cc: ${cc}` : undefined,
        bcc ? `Bcc: ${bcc}` : undefined,
        "Content-Type: text/plain; charset=utf-8",
        "MIME-Version: 1.0",
        `Subject: ${subject}`,
        inReplyTo ? `In-Reply-To: ${inReplyTo}` : undefined,
        references ? `References: ${references}` : undefined,
        "",
        body,
      ].filter(Boolean).join("\r\n");
    }

    const boundary = `mcp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const parts = [
      `To: ${to}`,
      cc ? `Cc: ${cc}` : undefined,
      bcc ? `Bcc: ${bcc}` : undefined,
      "MIME-Version: 1.0",
      `Subject: ${subject}`,
      inReplyTo ? `In-Reply-To: ${inReplyTo}` : undefined,
      references ? `References: ${references}` : undefined,
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: 7bit",
      "",
      body,
    ].filter(Boolean);

    for (const attachment of safeAttachments) {
      parts.push(
        `--${boundary}`,
        `Content-Type: ${attachment.mime_type || "application/octet-stream"}; name="${attachment.filename}"`,
        "Content-Transfer-Encoding: base64",
        `Content-Disposition: attachment; filename="${attachment.filename}"`,
        "",
        attachment.content_base64.replace(/\s+/g, "")
      );
    }

    parts.push(`--${boundary}--`, "");
    return parts.join("\r\n");
  };

  server.tool("gdrive_list_files", "Google Drive: list files. / Google Диск: получить список файлы.",
    {
      query: z.string().optional().describe("Input parameter. / Входной параметр."),
      folder_id: z.string().optional().describe("Input parameter. / Входной параметр."),
      page_size: z.number().int().min(1).max(100).optional().default(20).describe("Input parameter. / Входной параметр."),
      page_token: z.string().optional().describe("Input parameter. / Входной параметр."),
      order_by: z.string().optional().default("modifiedTime desc").describe("Input parameter. / Входной параметр."),
    },
    async ({ query, folder_id, page_size, page_token, order_by }) => {
      let q = "trashed = false";
      if (folder_id) q += ` and '${folder_id}' in parents`;
      if (query) q += ` and ${query}`;

      const res = await drive.files.list({
        q,
        pageSize: page_size,
        pageToken: page_token,
        orderBy: order_by,
        fields: "nextPageToken, files(id, name, mimeType, size, modifiedTime, parents, webViewLink, owners, driveId)",
      });

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            files: res.data.files,
            nextPageToken: res.data.nextPageToken,
          }, null, 2),
        }],
      };
    }
  );

  server.tool("gdrive_search", "Google Drive: search resource. / Google Диск: найти resource.",
    {
      search_term: z.string().describe("Input parameter. / Входной параметр."),
      mime_type: z.string().optional().describe("Input parameter. / Входной параметр."),
      limit: z.number().int().min(1).max(50).optional().default(10),
    },
    async ({ search_term, mime_type, limit }) => {
      let q = `trashed = false and (name contains '${search_term}' or fullText contains '${search_term}')`;
      if (mime_type) q += ` and mimeType = '${mime_type}'`;

      const res = await drive.files.list({
        q,
        pageSize: limit,
        fields: "files(id, name, mimeType, modifiedTime, webViewLink, size, driveId)",
      });

      return {
        content: [{ type: "text", text: JSON.stringify(res.data.files, null, 2) }],
      };
    }
  );

  server.tool("gdrive_read_file", "Google Drive: read file. / Google Диск: прочитать файлы.",
    {
      file_id: z.string().describe("Input parameter. / Входной параметр."),
      export_format: z.enum(["text", "markdown", "html", "pdf"]).optional().default("text").describe("Input parameter. / Входной параметр."),
    },
    async ({ file_id, export_format }) => {
      const meta = await drive.files.get({ fileId: file_id, fields: "id, name, mimeType" });
      const mimeType = meta.data.mimeType || "";

      let content: string;

      if (mimeType === "application/vnd.google-apps.document") {
        const exportMime = export_format === "html" ? "text/html" :
          export_format === "markdown" ? "text/markdown" : "text/plain";
        const res = await drive.files.export({ fileId: file_id, mimeType: exportMime }, { responseType: "text" });
        content = res.data as string;
      } else if (mimeType === "application/vnd.google-apps.spreadsheet") {
        const res = await drive.files.export({ fileId: file_id, mimeType: "text/csv" }, { responseType: "text" });
        content = res.data as string;
      } else if (mimeType === "application/vnd.google-apps.presentation") {
        const res = await drive.files.export({ fileId: file_id, mimeType: "text/plain" }, { responseType: "text" });
        content = res.data as string;
      } else {
        const res = await drive.files.get({ fileId: file_id, alt: "media" }, { responseType: "text" });
        content = res.data as string;
      }

      return {
        content: [{
          type: "text",
          text: `File / Файл: ${meta.data.name}\nType / Тип: ${mimeType}\n\n${content}`,
        }],
      };
    }
  );

  server.tool("gdrive_create_folder", "Google Drive: create folder. / Google Диск: создать папки.",
    {
      name: z.string().describe("Input parameter. / Входной параметр."),
      parent_id: z.string().optional().describe("Input parameter. / Входной параметр."),
    },
    async ({ name, parent_id }) => {
      const res = await drive.files.create({
        requestBody: {
          name,
          mimeType: "application/vnd.google-apps.folder",
          parents: parent_id ? [parent_id] : undefined,
        },
        fields: "id, name, webViewLink, driveId",
      });
      return {
        content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }],
      };
    }
  );

  server.tool("gdrive_upload_file", "Google Drive: upload file. / Google Диск: загрузить файлы.",
    {
      name: z.string().describe("Input parameter. / Входной параметр."),
      content: z.string().describe("Input parameter. / Входной параметр."),
      mime_type: z.string().optional().default("text/plain").describe("Input parameter. / Входной параметр."),
      parent_id: z.string().optional().describe("Input parameter. / Входной параметр."),
      convert_to_google: z.boolean().optional().default(false).describe("Input parameter. / Входной параметр."),
    },
    async ({ name, content, mime_type, parent_id, convert_to_google }) => {
      const media = { mimeType: mime_type, body: content };
      const requestBody: any = {
        name,
        parents: parent_id ? [parent_id] : undefined,
      };
      if (convert_to_google) {
        requestBody.mimeType = "application/vnd.google-apps.document";
      }

      const res = await drive.files.create({
        requestBody,
        media,
        fields: "id, name, mimeType, webViewLink, driveId",
      });
      return {
        content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }],
      };
    }
  );

  server.tool("gdrive_upload_binary_file", "Google Drive: upload binary file. / Google Диск: загрузить binary файлы.",
    {
      name: z.string().describe("Input parameter. / Входной параметр."),
      content_base64: z.string().describe("Input parameter. / Входной параметр."),
      mime_type: z.string().optional().default("application/octet-stream").describe("Input parameter. / Входной параметр."),
      parent_id: z.string().optional().describe("Input parameter. / Входной параметр."),
    },
    async ({ name, content_base64, mime_type, parent_id }) => {
      const media = {
        mimeType: mime_type,
        body: Buffer.from(content_base64, "base64"),
      };
      const res = await drive.files.create({
        requestBody: {
          name,
          parents: parent_id ? [parent_id] : undefined,
        },
        media,
        fields: "id, name, mimeType, size, webViewLink, webContentLink, driveId",
      });
      return asText(res.data);
    }
  );

  server.tool("gdrive_copy_file", "Google Drive: copy file. / Google Диск: скопировать файлы.",
    {
      file_id: z.string().describe("Input parameter. / Входной параметр."),
      new_name: z.string().optional().describe("Input parameter. / Входной параметр."),
      parent_id: z.string().optional().describe("Input parameter. / Входной параметр."),
    },
    async ({ file_id, new_name, parent_id }) => {
      const res = await drive.files.copy({
        fileId: file_id,
        requestBody: {
          name: new_name,
          parents: parent_id ? [parent_id] : undefined,
        },
        fields: "id, name, webViewLink, driveId",
      });
      return {
        content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }],
      };
    }
  );

  server.tool("gdrive_move_file", "Google Drive: move file. / Google Диск: переместить файлы.",
    {
      file_id: z.string().describe("Input parameter. / Входной параметр."),
      new_name: z.string().optional().describe("Input parameter. / Входной параметр."),
      new_parent_id: z.string().optional().describe("Input parameter. / Входной параметр."),
    },
    async ({ file_id, new_name, new_parent_id }) => {
      const current = await drive.files.get({ fileId: file_id, fields: "parents" });
      const oldParents = current.data.parents?.join(",");

      const res = await drive.files.update({
        fileId: file_id,
        addParents: new_parent_id,
        removeParents: new_parent_id && oldParents ? oldParents : undefined,
        requestBody: new_name ? { name: new_name } : {},
        fields: "id, name, parents, webViewLink",
      });
      return {
        content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }],
      };
    }
  );

  server.tool("gdrive_delete_file", "Google Drive: delete file. / Google Диск: удалить файлы.",
    { file_id: z.string().describe("Input parameter. / Входной параметр.") },
    async ({ file_id }) => {
      await drive.files.update({ fileId: file_id, requestBody: { trashed: true } });
      return {
        content: [{ type: "text", text: `File moved to trash / Файл перемещен в корзину: ${file_id}` }],
      };
    }
  );

  server.tool("gdrive_get_download_link", "Google Drive: get download link. / Google Диск: получить download link.",
    {
      file_id: z.string().describe("Input parameter. / Входной параметр."),
      export_mime: z.string().optional().describe("Input parameter. / Входной параметр."),
    },
    async ({ file_id, export_mime }) => {
      const meta = await drive.files.get({ fileId: file_id, fields: "id, name, mimeType, webContentLink, webViewLink" });
      const result: any = { ...meta.data };
      if (export_mime) {
        result.exportLink = `https://www.googleapis.com/drive/v3/files/${file_id}/export?mimeType=${encodeURIComponent(export_mime)}`;
      }
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool("gdrive_download_file", "Google Drive: download file. / Google Диск: скачать файлы.",
    {
      file_id: z.string().describe("Input parameter. / Входной параметр."),
      export_format: z.enum(["text", "markdown", "html", "pdf", "docx", "csv", "xlsx", "pptx", "txt"]).optional().default("pdf"),
      as_base64: z.boolean().optional().default(true).describe("Input parameter. / Входной параметр."),
    },
    async ({ file_id, export_format, as_base64 }) => {
      const meta = await drive.files.get({ fileId: file_id, fields: "id, name, mimeType, size, webViewLink, webContentLink" });
      const mimeType = meta.data.mimeType || "";
      const exportMime = getDriveExportMime(mimeType, export_format);

      let data: Buffer;
      let outputMime = mimeType;
      let mode: "download" | "export" = "download";

      if (exportMime) {
        const res = await drive.files.export(
          { fileId: file_id, mimeType: exportMime },
          { responseType: "arraybuffer" }
        );
        data = Buffer.from(res.data as ArrayBuffer);
        outputMime = exportMime;
        mode = "export";
      } else {
        const res = await drive.files.get(
          { fileId: file_id, alt: "media" },
          { responseType: "arraybuffer" }
        );
        data = Buffer.from(res.data as ArrayBuffer);
      }

      return asText({
        file: meta.data,
        mode,
        outputMime,
        size: data.length,
        contentBase64: as_base64 ? data.toString("base64") : undefined,
        contentText: !as_base64 && outputMime.startsWith("text/") ? data.toString("utf8") : undefined,
      });
    }
  );

  server.tool("gdrive_export_file", "Google Drive: export file. / Google Диск: экспортировать файлы.",
    {
      file_id: z.string().describe("Input parameter. / Входной параметр."),
      export_format: z.enum(["text", "markdown", "html", "pdf", "docx", "csv", "xlsx", "pptx", "txt"]),
    },
    async ({ file_id, export_format }) => {
      const meta = await drive.files.get({ fileId: file_id, fields: "id, name, mimeType" });
      const exportMime = getDriveExportMime(meta.data.mimeType || "", export_format);
      if (!exportMime) {
        throw new Error(`Export format ${export_format} is not supported for mimeType ${meta.data.mimeType}`);
      }
      const res = await drive.files.export(
        { fileId: file_id, mimeType: exportMime },
        { responseType: "arraybuffer" }
      );
      const data = Buffer.from(res.data as ArrayBuffer);
      return asText({
        file: meta.data,
        exportMime,
        size: data.length,
        contentBase64: data.toString("base64"),
      });
    }
  );

  server.tool("gdrive_share_file", "Google Drive: share file. / Google Диск: дать доступ файлы.",
    {
      file_id: z.string().describe("Input parameter. / Входной параметр."),
      email: z.string().optional().describe("Input parameter. / Входной параметр."),
      role: z.enum(["reader", "commenter", "writer"]).default("reader").describe("Input parameter. / Входной параметр."),
      send_notification: z.boolean().optional().default(true).describe("Input parameter. / Входной параметр."),
    },
    async ({ file_id, email, role, send_notification }) => {
      const res = await drive.permissions.create({
        fileId: file_id,
        sendNotificationEmail: send_notification,
        requestBody: {
          role,
          type: email ? "user" : "anyone",
          emailAddress: email,
        },
        fields: "id, role, type, emailAddress",
      });
      return {
        content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }],
      };
    }
  );

  server.tool("gdrive_list_permissions", "Google Drive: list permissions. / Google Диск: получить список доступы.",
    {
      file_id: z.string().describe("Input parameter. / Входной параметр."),
    },
    async ({ file_id }) => {
      const res = await drive.permissions.list({
        fileId: file_id,
        fields: "permissions(id,type,role,emailAddress,domain,allowFileDiscovery,deleted,displayName)",
      });
      return asText(res.data.permissions ?? []);
    }
  );

  server.tool("gdrive_list_revisions", "Google Drive: list revisions. / Google Диск: получить список revisions.",
    {
      file_id: z.string().describe("Input parameter. / Входной параметр."),
      page_size: z.number().int().min(1).max(200).optional().default(50),
    },
    async ({ file_id, page_size }) => {
      const res = await drive.revisions.list({
        fileId: file_id,
        pageSize: page_size,
        fields: "revisions(id,mimeType,modifiedTime,keepForever,lastModifyingUser,size,exportLinks)",
      });
      return asText(res.data.revisions ?? []);
    }
  );

  server.tool("gdrive_get_file", "Google Drive: get file. / Google Диск: получить файлы.",
    {
      file_id: z.string().describe("Input parameter. / Входной параметр."),
      fields: z.string().optional().default("*"),
      acknowledge_abuse: z.boolean().optional(),
      supports_all_drives: z.boolean().optional().default(true),
    },
    async ({ file_id, fields, acknowledge_abuse, supports_all_drives }) => {
      const res = await drive.files.get({
        fileId: file_id,
        fields,
        acknowledgeAbuse: acknowledge_abuse,
        supportsAllDrives: supports_all_drives,
      });
      return asText(res.data);
    }
  );

  server.tool("gdrive_update_file_metadata", "Google Drive: update file metadata. / Google Диск: обновить файлы метаданные.",
    {
      file_id: z.string().describe("Input parameter. / Входной параметр."),
      metadata: z.record(z.any()).optional().default({}),
      add_parents: z.string().optional(),
      remove_parents: z.string().optional(),
      fields: z.string().optional().default("id,name,mimeType,parents,webViewLink,driveId"),
      supports_all_drives: z.boolean().optional().default(true),
    },
    async ({ file_id, metadata, add_parents, remove_parents, fields, supports_all_drives }) => {
      const res = await drive.files.update({
        fileId: file_id,
        addParents: add_parents,
        removeParents: remove_parents,
        supportsAllDrives: supports_all_drives,
        requestBody: metadata,
        fields,
      });
      return asText(res.data);
    }
  );

  server.tool("gdrive_permanently_delete_file", "Google Drive: permanently delete file. / Google Диск: удалить навсегда файлы.",
    {
      file_id: z.string().describe("Input parameter. / Входной параметр."),
      supports_all_drives: z.boolean().optional().default(true),
    },
    async ({ file_id, supports_all_drives }) => {
      await drive.files.delete({ fileId: file_id, supportsAllDrives: supports_all_drives });
      return asText({ deleted: true, fileId: file_id });
    }
  );

  server.tool("gdrive_empty_trash", "Google Drive: empty trash. / Google Диск: очистить trash.",
    {
      drive_id: z.string().optional().describe("Input parameter. / Входной параметр."),
    },
    async ({ drive_id }) => {
      await drive.files.emptyTrash({ driveId: drive_id });
      return asText({ emptied: true, driveId: drive_id ?? null });
    }
  );

  server.tool("gdrive_generate_file_ids", "Google Drive: generate file ids. / Google Диск: сгенерировать файлы ids.",
    {
      count: z.number().int().min(1).max(1000).optional().default(10),
      space: z.string().optional().default("drive"),
      type: z.string().optional(),
    },
    async ({ count, space, type }) => {
      const res = await drive.files.generateIds({ count, space, type });
      return asText(res.data);
    }
  );

  server.tool("gdrive_get_permission", "Google Drive: get permission. / Google Диск: получить доступы.",
    {
      file_id: z.string(),
      permission_id: z.string(),
      fields: z.string().optional().default("*"),
      supports_all_drives: z.boolean().optional().default(true),
    },
    async ({ file_id, permission_id, fields, supports_all_drives }) => {
      const res = await drive.permissions.get({
        fileId: file_id,
        permissionId: permission_id,
        fields,
        supportsAllDrives: supports_all_drives,
      });
      return asText(res.data);
    }
  );

  server.tool("gdrive_update_permission", "Google Drive: update permission. / Google Диск: обновить доступы.",
    {
      file_id: z.string(),
      permission_id: z.string(),
      permission: z.record(z.any()).describe("Permission resource patch"),
      fields: z.string().optional().default("*"),
      supports_all_drives: z.boolean().optional().default(true),
    },
    async ({ file_id, permission_id, permission, fields, supports_all_drives }) => {
      const res = await drive.permissions.update({
        fileId: file_id,
        permissionId: permission_id,
        requestBody: permission,
        fields,
        supportsAllDrives: supports_all_drives,
      });
      return asText(res.data);
    }
  );

  server.tool("gdrive_delete_permission", "Google Drive: delete permission. / Google Диск: удалить доступы.",
    {
      file_id: z.string(),
      permission_id: z.string(),
      supports_all_drives: z.boolean().optional().default(true),
    },
    async ({ file_id, permission_id, supports_all_drives }) => {
      await drive.permissions.delete({
        fileId: file_id,
        permissionId: permission_id,
        supportsAllDrives: supports_all_drives,
      });
      return asText({ deleted: true, fileId: file_id, permissionId: permission_id });
    }
  );

  server.tool("gdrive_get_revision", "Google Drive: get revision. / Google Диск: получить revision.",
    {
      file_id: z.string(),
      revision_id: z.string(),
      fields: z.string().optional().default("*"),
    },
    async ({ file_id, revision_id, fields }) => {
      const res = await drive.revisions.get({ fileId: file_id, revisionId: revision_id, fields });
      return asText(res.data);
    }
  );

  server.tool("gdrive_update_revision", "Google Drive: update revision. / Google Диск: обновить revision.",
    {
      file_id: z.string(),
      revision_id: z.string(),
      revision: z.record(z.any()).describe("Revision patch, e.g. keepForever"),
      fields: z.string().optional().default("*"),
    },
    async ({ file_id, revision_id, revision, fields }) => {
      const res = await drive.revisions.update({
        fileId: file_id,
        revisionId: revision_id,
        requestBody: revision,
        fields,
      });
      return asText(res.data);
    }
  );

  server.tool("gdrive_delete_revision", "Google Drive: delete revision. / Google Диск: удалить revision.",
    {
      file_id: z.string(),
      revision_id: z.string(),
    },
    async ({ file_id, revision_id }) => {
      await drive.revisions.delete({ fileId: file_id, revisionId: revision_id });
      return asText({ deleted: true, fileId: file_id, revisionId: revision_id });
    }
  );

  server.tool("gdrive_list_comments", "Google Drive: list comments. / Google Диск: получить список комментарии.",
    {
      file_id: z.string(),
      page_size: z.number().int().min(1).max(100).optional().default(50),
      page_token: z.string().optional(),
      fields: z.string().optional().default("*"),
    },
    async ({ file_id, page_size, page_token, fields }) => {
      const res = await drive.comments.list({
        fileId: file_id,
        pageSize: page_size,
        pageToken: page_token,
        fields,
      });
      return asText(res.data);
    }
  );

  server.tool("gdrive_create_comment", "Google Drive: create comment. / Google Диск: создать комментарии.",
    {
      file_id: z.string(),
      content: z.string(),
      quoted_file_content: z.record(z.any()).optional(),
      fields: z.string().optional().default("*"),
    },
    async ({ file_id, content, quoted_file_content, fields }) => {
      const res = await drive.comments.create({
        fileId: file_id,
        fields,
        requestBody: {
          content,
          quotedFileContent: quoted_file_content,
        },
      });
      return asText(res.data);
    }
  );

  server.tool("gdrive_get_comment", "Google Drive: get comment. / Google Диск: получить комментарии.",
    {
      file_id: z.string(),
      comment_id: z.string(),
      fields: z.string().optional().default("*"),
    },
    async ({ file_id, comment_id, fields }) => {
      const res = await drive.comments.get({ fileId: file_id, commentId: comment_id, fields });
      return asText(res.data);
    }
  );

  server.tool("gdrive_update_comment", "Google Drive: update comment. / Google Диск: обновить комментарии.",
    {
      file_id: z.string(),
      comment_id: z.string(),
      content: z.string(),
      fields: z.string().optional().default("*"),
    },
    async ({ file_id, comment_id, content, fields }) => {
      const res = await drive.comments.update({
        fileId: file_id,
        commentId: comment_id,
        fields,
        requestBody: { content },
      });
      return asText(res.data);
    }
  );

  server.tool("gdrive_delete_comment", "Google Drive: delete comment. / Google Диск: удалить комментарии.",
    {
      file_id: z.string(),
      comment_id: z.string(),
    },
    async ({ file_id, comment_id }) => {
      await drive.comments.delete({ fileId: file_id, commentId: comment_id });
      return asText({ deleted: true, fileId: file_id, commentId: comment_id });
    }
  );

  server.tool("gdrive_list_replies", "Google Drive: list replies. / Google Диск: получить список ответы.",
    {
      file_id: z.string(),
      comment_id: z.string(),
      page_size: z.number().int().min(1).max(100).optional().default(50),
      page_token: z.string().optional(),
      fields: z.string().optional().default("*"),
    },
    async ({ file_id, comment_id, page_size, page_token, fields }) => {
      const res = await drive.replies.list({
        fileId: file_id,
        commentId: comment_id,
        pageSize: page_size,
        pageToken: page_token,
        fields,
      });
      return asText(res.data);
    }
  );

  server.tool("gdrive_create_reply", "Google Drive: create reply. / Google Диск: создать reply.",
    {
      file_id: z.string(),
      comment_id: z.string(),
      content: z.string(),
      action: z.string().optional().describe("Input parameter. / Входной параметр."),
      fields: z.string().optional().default("*"),
    },
    async ({ file_id, comment_id, content, action, fields }) => {
      const res = await drive.replies.create({
        fileId: file_id,
        commentId: comment_id,
        fields,
        requestBody: { content, action },
      });
      return asText(res.data);
    }
  );

  server.tool("gdrive_get_reply", "Google Drive: get reply. / Google Диск: получить reply.",
    {
      file_id: z.string(),
      comment_id: z.string(),
      reply_id: z.string(),
      fields: z.string().optional().default("*"),
    },
    async ({ file_id, comment_id, reply_id, fields }) => {
      const res = await drive.replies.get({ fileId: file_id, commentId: comment_id, replyId: reply_id, fields });
      return asText(res.data);
    }
  );

  server.tool("gdrive_update_reply", "Google Drive: update reply. / Google Диск: обновить reply.",
    {
      file_id: z.string(),
      comment_id: z.string(),
      reply_id: z.string(),
      content: z.string(),
      action: z.string().optional(),
      fields: z.string().optional().default("*"),
    },
    async ({ file_id, comment_id, reply_id, content, action, fields }) => {
      const res = await drive.replies.update({
        fileId: file_id,
        commentId: comment_id,
        replyId: reply_id,
        fields,
        requestBody: { content, action },
      });
      return asText(res.data);
    }
  );

  server.tool("gdrive_delete_reply", "Google Drive: delete reply. / Google Диск: удалить reply.",
    {
      file_id: z.string(),
      comment_id: z.string(),
      reply_id: z.string(),
    },
    async ({ file_id, comment_id, reply_id }) => {
      await drive.replies.delete({ fileId: file_id, commentId: comment_id, replyId: reply_id });
      return asText({ deleted: true, fileId: file_id, commentId: comment_id, replyId: reply_id });
    }
  );

  server.tool("gdrive_get_start_page_token", "Google Drive: get start page token. / Google Диск: получить start page token.",
    {
      drive_id: z.string().optional(),
      supports_all_drives: z.boolean().optional().default(true),
    },
    async ({ drive_id, supports_all_drives }) => {
      const res = await drive.changes.getStartPageToken({
        driveId: drive_id,
        supportsAllDrives: supports_all_drives,
      });
      return asText(res.data);
    }
  );

  server.tool("gdrive_list_changes", "Google Drive: list changes. / Google Диск: получить список changes.",
    {
      page_token: z.string().describe("Page token from getStartPageToken or previous response"),
      page_size: z.number().int().min(1).max(1000).optional().default(100),
      drive_id: z.string().optional(),
      include_items_from_all_drives: z.boolean().optional().default(true),
      supports_all_drives: z.boolean().optional().default(true),
      fields: z.string().optional().default("*"),
    },
    async ({ page_token, page_size, drive_id, include_items_from_all_drives, supports_all_drives, fields }) => {
      const res = await drive.changes.list({
        pageToken: page_token,
        pageSize: page_size,
        driveId: drive_id,
        includeItemsFromAllDrives: include_items_from_all_drives,
        supportsAllDrives: supports_all_drives,
        fields,
      });
      return asText(res.data);
    }
  );

  server.tool("gdrive_watch_changes", "Google Drive: watch changes changes. / Google Диск: отслеживать изменения changes.",
    {
      page_token: z.string(),
      channel: z.record(z.any()).describe("Drive Channel object: id,type,address,token,expiration..."),
      drive_id: z.string().optional(),
      include_items_from_all_drives: z.boolean().optional().default(true),
      supports_all_drives: z.boolean().optional().default(true),
    },
    async ({ page_token, channel, drive_id, include_items_from_all_drives, supports_all_drives }) => {
      const res = await drive.changes.watch({
        pageToken: page_token,
        driveId: drive_id,
        includeItemsFromAllDrives: include_items_from_all_drives,
        supportsAllDrives: supports_all_drives,
        requestBody: channel,
      });
      return asText(res.data);
    }
  );

  server.tool("gdrive_watch_file", "Google Drive: watch changes file. / Google Диск: отслеживать изменения файлы.",
    {
      file_id: z.string(),
      channel: z.record(z.any()).describe("Drive Channel object: id,type,address,token,expiration..."),
      supports_all_drives: z.boolean().optional().default(true),
    },
    async ({ file_id, channel, supports_all_drives }) => {
      const res = await drive.files.watch({
        fileId: file_id,
        supportsAllDrives: supports_all_drives,
        requestBody: channel,
      });
      return asText(res.data);
    }
  );

  server.tool("gdrive_stop_channel", "Google Drive: stop channel channel. / Google Диск: остановить канал channel.",
    {
      channel: z.record(z.any()).describe("Channel object with id and resourceId"),
    },
    async ({ channel }) => {
      await drive.channels.stop({ requestBody: channel });
      return asText({ stopped: true, channel });
    }
  );

  server.tool("gdrive_list_shared_drives", "Google Drive: list shared drives. / Google Диск: получить список shared drives.",
    {
      page_size: z.number().int().min(1).max(100).optional().default(20),
      page_token: z.string().optional(),
      query: z.string().optional(),
      fields: z.string().optional().default("*"),
    },
    async ({ page_size, page_token, query, fields }) => {
      const res = await drive.drives.list({ pageSize: page_size, pageToken: page_token, q: query, fields });
      return asText(res.data);
    }
  );

  server.tool("gdrive_get_shared_drive", "Google Drive: get shared drive. / Google Диск: получить shared drive.",
    {
      drive_id: z.string(),
      fields: z.string().optional().default("*"),
    },
    async ({ drive_id, fields }) => {
      const res = await drive.drives.get({ driveId: drive_id, fields });
      return asText(res.data);
    }
  );

  server.tool("gdrive_create_shared_drive", "Google Drive: create shared drive. / Google Диск: создать shared drive.",
    {
      name: z.string(),
      request_id: z.string().describe("Input parameter. / Входной параметр."),
      fields: z.string().optional().default("*"),
    },
    async ({ name, request_id, fields }) => {
      const res = await drive.drives.create({ requestId: request_id, fields, requestBody: { name } });
      return asText(res.data);
    }
  );

  server.tool("gdrive_update_shared_drive", "Google Drive: update shared drive. / Google Диск: обновить shared drive.",
    {
      drive_id: z.string(),
      drive: z.record(z.any()).describe("Shared drive patch"),
      fields: z.string().optional().default("*"),
    },
    async ({ drive_id, drive: drivePatch, fields }) => {
      const res = await drive.drives.update({ driveId: drive_id, requestBody: drivePatch, fields });
      return asText(res.data);
    }
  );

  server.tool("gdrive_hide_shared_drive", "Google Drive: hide shared drive. / Google Диск: скрыть shared drive.",
    { drive_id: z.string() },
    async ({ drive_id }) => {
      const res = await drive.drives.hide({ driveId: drive_id });
      return asText(res.data);
    }
  );

  server.tool("gdrive_unhide_shared_drive", "Google Drive: unhide shared drive. / Google Диск: показать shared drive.",
    { drive_id: z.string() },
    async ({ drive_id }) => {
      const res = await drive.drives.unhide({ driveId: drive_id });
      return asText(res.data);
    }
  );

  server.tool("gdrive_delete_shared_drive", "Google Drive: delete shared drive. / Google Диск: удалить shared drive.",
    {
      drive_id: z.string(),
      allow_item_deletion: z.boolean().optional(),
    },
    async ({ drive_id, allow_item_deletion }) => {
      await drive.drives.delete({ driveId: drive_id, allowItemDeletion: allow_item_deletion });
      return asText({ deleted: true, driveId: drive_id });
    }
  );

  server.tool("gdrive_list_apps", "Google Drive: list apps. / Google Диск: получить список apps.",
    {},
    async () => {
      const res = await drive.apps.list({});
      return asText(res.data);
    }
  );

  server.tool("gdrive_get_app", "Google Drive: get app. / Google Диск: получить app.",
    { app_id: z.string() },
    async ({ app_id }) => {
      const res = await drive.apps.get({ appId: app_id });
      return asText(res.data);
    }
  );

  server.tool("gdrive_list_access_proposals", "Google Drive: list access proposals. / Google Диск: получить список access proposals.",
    {
      file_id: z.string(),
      page_size: z.number().int().min(1).max(100).optional().default(20),
      page_token: z.string().optional(),
    },
    async ({ file_id, page_size, page_token }) => {
      const res = await driveAny.accessproposals.list({ fileId: file_id, pageSize: page_size, pageToken: page_token });
      return asText(res.data);
    }
  );

  server.tool("gdrive_get_access_proposal", "Google Drive: get access proposal. / Google Диск: получить access proposal.",
    {
      file_id: z.string(),
      proposal_id: z.string(),
    },
    async ({ file_id, proposal_id }) => {
      const res = await driveAny.accessproposals.get({ fileId: file_id, proposalId: proposal_id });
      return asText(res.data);
    }
  );

  server.tool("gdrive_resolve_access_proposal", "Google Drive: resolve access proposal. / Google Диск: resolve access proposal.",
    {
      file_id: z.string(),
      proposal_id: z.string(),
      role: z.string().optional(),
      view: z.string().optional(),
      action: z.enum(["ACCEPT", "DENY"]).describe("Resolution action"),
      send_notification: z.boolean().optional(),
    },
    async ({ file_id, proposal_id, role, view, action, send_notification }) => {
      const res = await driveAny.accessproposals.resolve({
        fileId: file_id,
        proposalId: proposal_id,
        requestBody: { role, view, action, sendNotification: send_notification },
      });
      return asText(res.data);
    }
  );

  server.tool("gdrive_doc_append_text", "Google Drive: doc append text. / Google Диск: doc append text.",
    {
      document_id: z.string().describe("Input parameter. / Входной параметр."),
      text: z.string().describe("Input parameter. / Входной параметр."),
    },
    async ({ document_id, text }) => {
      const doc = await docs.documents.get({ documentId: document_id });
      const endIndex = doc.data.body?.content?.at(-1)?.endIndex ?? 1;

      await docs.documents.batchUpdate({
        documentId: document_id,
        requestBody: {
          requests: [{
            insertText: {
              location: { index: endIndex - 1 },
              text: "\n" + text,
            },
          }],
        },
      });
      return {
        content: [{ type: "text", text: `Text appended to document / Текст добавлен в документ: ${document_id}` }],
      };
    }
  );

  server.tool("gdocs_create_document", "Google Docs: create document. / Google Документы: создать document.",
    {
      title: z.string().describe("Input parameter. / Входной параметр."),
      body_text: z.string().optional().describe("Input parameter. / Входной параметр."),
      parent_id: z.string().optional().describe("Input parameter. / Входной параметр."),
    },
    async ({ title, body_text, parent_id }) => {
      const created = await drive.files.create({
        requestBody: {
          name: title,
          mimeType: "application/vnd.google-apps.document",
          parents: parent_id ? [parent_id] : undefined,
        },
        fields: "id,name,webViewLink",
      });
      const documentId = created.data.id!;
      if (body_text) {
        await docs.documents.batchUpdate({
          documentId,
          requestBody: {
            requests: [{
              insertText: {
                location: { index: 1 },
                text: body_text,
              },
            }],
          },
        });
      }
      return asText({ ...created.data, documentId });
    }
  );

  server.tool("gdocs_replace_text", "Google Docs: replace text. / Google Документы: replace text.",
    {
      document_id: z.string().describe("Input parameter. / Входной параметр."),
      search_text: z.string().describe("Input parameter. / Входной параметр."),
      replace_text: z.string().describe("Input parameter. / Входной параметр."),
      match_case: z.boolean().optional().default(false),
    },
    async ({ document_id, search_text, replace_text, match_case }) => {
      const res = await docs.documents.batchUpdate({
        documentId: document_id,
        requestBody: {
          requests: [{
            replaceAllText: {
              containsText: {
                text: search_text,
                matchCase: match_case,
              },
              replaceText: replace_text,
            },
          }],
        },
      });
      return asText(res.data);
    }
  );

  server.tool("gdrive_sheets_read", "Google Drive: sheets read. / Google Диск: sheets read.",
    {
      spreadsheet_id: z.string().describe("Input parameter. / Входной параметр."),
      range: z.string().optional().default("A1:Z1000").describe("Input parameter. / Входной параметр."),
    },
    async ({ spreadsheet_id, range }) => {
      const res = await sheets.spreadsheets.values.get({ spreadsheetId: spreadsheet_id, range });
      return {
        content: [{ type: "text", text: JSON.stringify(res.data.values, null, 2) }],
      };
    }
  );

  server.tool("gsheets_create_spreadsheet", "Google Sheets: create spreadsheet. / Google Таблицы: создать spreadлисты.",
    {
      title: z.string().describe("Input parameter. / Входной параметр."),
      sheet_titles: z.array(z.string()).optional().describe("Input parameter. / Входной параметр."),
    },
    async ({ title, sheet_titles }) => {
      const res = await sheets.spreadsheets.create({
        requestBody: {
          properties: { title },
          sheets: (sheet_titles ?? []).map((sheetTitle) => ({
            properties: { title: sheetTitle },
          })),
        },
      });
      return asText(res.data);
    }
  );

  server.tool("gdrive_sheets_write", "Google Drive: sheets write. / Google Диск: sheets write.",
    {
      spreadsheet_id: z.string().describe("Input parameter. / Входной параметр."),
      range: z.string().describe("Input parameter. / Входной параметр."),
      values: z.array(z.array(z.string())).describe("Input parameter. / Входной параметр."),
    },
    async ({ spreadsheet_id, range, values }) => {
      const res = await sheets.spreadsheets.values.update({
        spreadsheetId: spreadsheet_id,
        range,
        valueInputOption: "USER_ENTERED",
        requestBody: { values },
      });
      return {
        content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }],
      };
    }
  );

  server.tool("gsheets_append_rows", "Google Sheets: append rows. / Google Таблицы: добавить в конец rows.",
    {
      spreadsheet_id: z.string().describe("Input parameter. / Входной параметр."),
      range: z.string().describe("Input parameter. / Входной параметр."),
      values: z.array(z.array(z.string())).describe("Input parameter. / Входной параметр."),
    },
    async ({ spreadsheet_id, range, values }) => {
      const res = await sheets.spreadsheets.values.append({
        spreadsheetId: spreadsheet_id,
        range,
        valueInputOption: "USER_ENTERED",
        insertDataOption: "INSERT_ROWS",
        requestBody: { values },
      });
      return asText(res.data);
    }
  );

  server.tool("gsheets_clear_range", "Google Sheets: clear range. / Google Таблицы: очистить range.",
    {
      spreadsheet_id: z.string().describe("Input parameter. / Входной параметр."),
      range: z.string().describe("Input parameter. / Входной параметр."),
    },
    async ({ spreadsheet_id, range }) => {
      const res = await sheets.spreadsheets.values.clear({
        spreadsheetId: spreadsheet_id,
        range,
      });
      return asText(res.data);
    }
  );

  server.tool("gsheets_batch_get", "Google Sheets: batch operation get. / Google Таблицы: пакетная операция get.",
    {
      spreadsheet_id: z.string().describe("Input parameter. / Входной параметр."),
      ranges: z.array(z.string()).min(1).describe("Input parameter. / Входной параметр."),
    },
    async ({ spreadsheet_id, ranges }) => {
      const res = await sheets.spreadsheets.values.batchGet({
        spreadsheetId: spreadsheet_id,
        ranges,
      });
      return asText(res.data.valueRanges ?? []);
    }
  );

  server.tool("gsheets_batch_update_values", "Google Sheets: batch operation update values. / Google Таблицы: пакетная операция update values.",
    {
      spreadsheet_id: z.string().describe("Input parameter. / Входной параметр."),
      updates: z.array(z.object({
        range: z.string(),
        values: z.array(z.array(z.string())),
      })).min(1),
    },
    async ({ spreadsheet_id, updates }) => {
      const res = await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: spreadsheet_id,
        requestBody: {
          valueInputOption: "USER_ENTERED",
          data: updates,
        },
      });
      return asText(res.data);
    }
  );

  server.tool("gsheets_get_spreadsheet", "Google Sheets: get spreadsheet. / Google Таблицы: получить spreadлисты.",
    {
      spreadsheet_id: z.string().describe("Input parameter. / Входной параметр."),
      ranges: z.array(z.string()).optional().describe("Input parameter. / Входной параметр."),
      include_grid_data: z.boolean().optional().default(false).describe("Input parameter. / Входной параметр."),
      fields: z.string().optional().describe("Input parameter. / Входной параметр."),
    },
    async ({ spreadsheet_id, ranges, include_grid_data, fields }) => {
      const res = await sheets.spreadsheets.get({
        spreadsheetId: spreadsheet_id,
        ranges,
        includeGridData: include_grid_data,
        fields,
      });
      return asText(res.data);
    }
  );

  server.tool("gsheets_batch_update_requests", "Google Sheets: batch operation update requests. / Google Таблицы: пакетная операция update requests.",
    {
      spreadsheet_id: z.string().describe("Input parameter. / Входной параметр."),
      requests: z.array(z.record(z.any())).min(1).describe("Input parameter. / Входной параметр."),
      include_spreadsheet_in_response: z.boolean().optional().default(false),
      response_ranges: z.array(z.string()).optional(),
    },
    async ({ spreadsheet_id, requests, include_spreadsheet_in_response, response_ranges }) => {
      const res = await sheets.spreadsheets.batchUpdate({
        spreadsheetId: spreadsheet_id,
        requestBody: {
          requests,
          includeSpreadsheetInResponse: include_spreadsheet_in_response,
          responseRanges: response_ranges,
        },
      });
      return asText(res.data);
    }
  );

  server.tool("gsheets_add_sheet", "Google Sheets: add sheet. / Google Таблицы: добавить листы.",
    {
      spreadsheet_id: z.string().describe("Input parameter. / Входной параметр."),
      title: z.string().describe("Input parameter. / Входной параметр."),
      row_count: z.number().int().positive().optional().default(1000),
      column_count: z.number().int().positive().optional().default(26),
    },
    async ({ spreadsheet_id, title, row_count, column_count }) => {
      const res = await sheets.spreadsheets.batchUpdate({
        spreadsheetId: spreadsheet_id,
        requestBody: {
          requests: [{
            addSheet: {
              properties: {
                title,
                gridProperties: { rowCount: row_count, columnCount: column_count },
              },
            },
          }],
        },
      });
      return asText(res.data);
    }
  );

  server.tool("gsheets_delete_sheet", "Google Sheets: delete sheet. / Google Таблицы: удалить листы.",
    {
      spreadsheet_id: z.string().describe("Input parameter. / Входной параметр."),
      sheet_id: z.number().int().describe("Input parameter. / Входной параметр."),
    },
    async ({ spreadsheet_id, sheet_id }) => {
      const res = await sheets.spreadsheets.batchUpdate({
        spreadsheetId: spreadsheet_id,
        requestBody: { requests: [{ deleteSheet: { sheetId: sheet_id } }] },
      });
      return asText(res.data);
    }
  );

  server.tool("gsheets_rename_sheet", "Google Sheets: rename sheet. / Google Таблицы: переименовать листы.",
    {
      spreadsheet_id: z.string().describe("Input parameter. / Входной параметр."),
      sheet_id: z.number().int().describe("Input parameter. / Входной параметр."),
      title: z.string().describe("Input parameter. / Входной параметр."),
    },
    async ({ spreadsheet_id, sheet_id, title }) => {
      const res = await sheets.spreadsheets.batchUpdate({
        spreadsheetId: spreadsheet_id,
        requestBody: {
          requests: [{
            updateSheetProperties: {
              properties: { sheetId: sheet_id, title },
              fields: "title",
            },
          }],
        },
      });
      return asText(res.data);
    }
  );

  server.tool("gsheets_resize_sheet", "Google Sheets: resize sheet. / Google Таблицы: изменить размер листы.",
    {
      spreadsheet_id: z.string().describe("Input parameter. / Входной параметр."),
      sheet_id: z.number().int().describe("Input parameter. / Входной параметр."),
      row_count: z.number().int().positive().optional(),
      column_count: z.number().int().positive().optional(),
    },
    async ({ spreadsheet_id, sheet_id, row_count, column_count }) => {
      const gridProperties: Record<string, number> = {};
      const fields: string[] = [];
      if (row_count !== undefined) {
        gridProperties.rowCount = row_count;
        fields.push("gridProperties.rowCount");
      }
      if (column_count !== undefined) {
        gridProperties.columnCount = column_count;
        fields.push("gridProperties.columnCount");
      }
      if (!fields.length) throw new Error("row_count or column_count is required");
      const res = await sheets.spreadsheets.batchUpdate({
        spreadsheetId: spreadsheet_id,
        requestBody: {
          requests: [{
            updateSheetProperties: {
              properties: { sheetId: sheet_id, gridProperties },
              fields: fields.join(","),
            },
          }],
        },
      });
      return asText(res.data);
    }
  );

  server.tool("gsheets_freeze_sheet", "Google Sheets: freeze sheet. / Google Таблицы: закрепить листы.",
    {
      spreadsheet_id: z.string().describe("Input parameter. / Входной параметр."),
      sheet_id: z.number().int().describe("Input parameter. / Входной параметр."),
      frozen_row_count: z.number().int().min(0).optional().default(0),
      frozen_column_count: z.number().int().min(0).optional().default(0),
    },
    async ({ spreadsheet_id, sheet_id, frozen_row_count, frozen_column_count }) => {
      const res = await sheets.spreadsheets.batchUpdate({
        spreadsheetId: spreadsheet_id,
        requestBody: {
          requests: [{
            updateSheetProperties: {
              properties: {
                sheetId: sheet_id,
                gridProperties: {
                  frozenRowCount: frozen_row_count,
                  frozenColumnCount: frozen_column_count,
                },
              },
              fields: "gridProperties.frozenRowCount,gridProperties.frozenColumnCount",
            },
          }],
        },
      });
      return asText(res.data);
    }
  );

  server.tool("gsheets_format_range", "Google Sheets: format range. / Google Таблицы: форматировать range.",
    {
      spreadsheet_id: z.string().describe("Input parameter. / Входной параметр."),
      sheet_id: z.number().int().describe("Input parameter. / Входной параметр."),
      start_row_index: z.number().int().min(0).optional(),
      end_row_index: z.number().int().min(0).optional(),
      start_column_index: z.number().int().min(0).optional(),
      end_column_index: z.number().int().min(0).optional(),
      user_entered_format: z.record(z.any()).describe("Google Sheets CellFormat object"),
      fields: z.string().optional().default("userEnteredFormat").describe("Input parameter. / Входной параметр."),
    },
    async ({ spreadsheet_id, sheet_id, start_row_index, end_row_index, start_column_index, end_column_index, user_entered_format, fields }) => {
      const range: Record<string, number> = { sheetId: sheet_id };
      if (start_row_index !== undefined) range.startRowIndex = start_row_index;
      if (end_row_index !== undefined) range.endRowIndex = end_row_index;
      if (start_column_index !== undefined) range.startColumnIndex = start_column_index;
      if (end_column_index !== undefined) range.endColumnIndex = end_column_index;
      const res = await sheets.spreadsheets.batchUpdate({
        spreadsheetId: spreadsheet_id,
        requestBody: {
          requests: [{
            repeatCell: {
              range,
              cell: { userEnteredFormat: user_entered_format },
              fields,
            },
          }],
        },
      });
      return asText(res.data);
    }
  );

  server.tool("gsheets_copy_sheet_to_spreadsheet", "Google Sheets: copy sheet to spreadsheet. / Google Таблицы: скопировать листы to spreadлисты.",
    {
      spreadsheet_id: z.string().describe("Input parameter. / Входной параметр."),
      sheet_id: z.number().int().describe("Input parameter. / Входной параметр."),
      destination_spreadsheet_id: z.string().describe("Input parameter. / Входной параметр."),
    },
    async ({ spreadsheet_id, sheet_id, destination_spreadsheet_id }) => {
      const res = await sheets.spreadsheets.sheets.copyTo({
        spreadsheetId: spreadsheet_id,
        sheetId: sheet_id,
        requestBody: { destinationSpreadsheetId: destination_spreadsheet_id },
      });
      return asText(res.data);
    }
  );

  server.tool("gsheets_find_replace", "Google Sheets: find and replace replace. / Google Таблицы: найти и заменить replace.",
    {
      spreadsheet_id: z.string().describe("Input parameter. / Входной параметр."),
      find: z.string().describe("Input parameter. / Входной параметр."),
      replacement: z.string().describe("Input parameter. / Входной параметр."),
      sheet_id: z.number().int().optional().describe("Input parameter. / Входной параметр."),
      all_sheets: z.boolean().optional().default(true),
      match_case: z.boolean().optional().default(false),
      match_entire_cell: z.boolean().optional().default(false),
      search_by_regex: z.boolean().optional().default(false),
      include_formulas: z.boolean().optional().default(false),
    },
    async ({ spreadsheet_id, find, replacement, sheet_id, all_sheets, match_case, match_entire_cell, search_by_regex, include_formulas }) => {
      const findReplace: Record<string, unknown> = {
        find,
        replacement,
        allSheets: all_sheets,
        matchCase: match_case,
        matchEntireCell: match_entire_cell,
        searchByRegex: search_by_regex,
        includeFormulas: include_formulas,
      };
      if (sheet_id !== undefined) {
        findReplace.sheetId = sheet_id;
        findReplace.allSheets = false;
      }
      const res = await sheets.spreadsheets.batchUpdate({
        spreadsheetId: spreadsheet_id,
        requestBody: { requests: [{ findReplace }] },
      });
      return asText(res.data);
    }
  );

  server.tool("gsheets_batch_clear", "Google Sheets: batch operation clear. / Google Таблицы: пакетная операция clear.",
    {
      spreadsheet_id: z.string().describe("Input parameter. / Входной параметр."),
      ranges: z.array(z.string()).min(1).describe("Input parameter. / Входной параметр."),
    },
    async ({ spreadsheet_id, ranges }) => {
      const res = await sheets.spreadsheets.values.batchClear({
        spreadsheetId: spreadsheet_id,
        requestBody: { ranges },
      });
      return asText(res.data);
    }
  );

  server.tool("gsheets_batch_get_by_data_filter", "Google Sheets: batch operation get by data filter. / Google Таблицы: пакетная операция get by data filter.",
    {
      spreadsheet_id: z.string().describe("Input parameter. / Входной параметр."),
      data_filters: z.array(z.record(z.any())).min(1).describe("Input parameter. / Входной параметр."),
      major_dimension: z.enum(["ROWS", "COLUMNS"]).optional(),
    },
    async ({ spreadsheet_id, data_filters, major_dimension }) => {
      const res = await sheets.spreadsheets.values.batchGetByDataFilter({
        spreadsheetId: spreadsheet_id,
        requestBody: {
          dataFilters: data_filters,
          majorDimension: major_dimension,
        },
      });
      return asText(res.data);
    }
  );

  server.tool("gsheets_batch_update_by_data_filter", "Google Sheets: batch operation update by data filter. / Google Таблицы: пакетная операция update by data filter.",
    {
      spreadsheet_id: z.string().describe("Input parameter. / Входной параметр."),
      data: z.array(z.record(z.any())).min(1).describe("Input parameter. / Входной параметр."),
      value_input_option: z.enum(["RAW", "USER_ENTERED"]).optional().default("USER_ENTERED"),
    },
    async ({ spreadsheet_id, data, value_input_option }) => {
      const res = await sheets.spreadsheets.values.batchUpdateByDataFilter({
        spreadsheetId: spreadsheet_id,
        requestBody: {
          data,
          valueInputOption: value_input_option,
        },
      });
      return asText(res.data);
    }
  );

  server.tool("gsheets_get_spreadsheet_by_data_filter", "Google Sheets: get spreadsheet by data filter. / Google Таблицы: получить spreadлисты by data filter.",
    {
      spreadsheet_id: z.string().describe("Input parameter. / Входной параметр."),
      data_filters: z.array(z.record(z.any())).min(1).describe("Input parameter. / Входной параметр."),
      include_grid_data: z.boolean().optional().default(false),
    },
    async ({ spreadsheet_id, data_filters, include_grid_data }) => {
      const res = await sheets.spreadsheets.getByDataFilter({
        spreadsheetId: spreadsheet_id,
        requestBody: {
          dataFilters: data_filters,
          includeGridData: include_grid_data,
        },
      });
      return asText(res.data);
    }
  );

  server.tool("gsheets_values_get_advanced", "Google Sheets: values get advanced. / Google Таблицы: values get advanced.",
    {
      spreadsheet_id: z.string().describe("Input parameter. / Входной параметр."),
      range: z.string().describe("Input parameter. / Входной параметр."),
      major_dimension: z.enum(["ROWS", "COLUMNS"]).optional(),
      value_render_option: z.enum(["FORMATTED_VALUE", "UNFORMATTED_VALUE", "FORMULA"]).optional(),
      date_time_render_option: z.enum(["SERIAL_NUMBER", "FORMATTED_STRING"]).optional(),
    },
    async ({ spreadsheet_id, range, major_dimension, value_render_option, date_time_render_option }) => {
      const res = await sheets.spreadsheets.values.get({
        spreadsheetId: spreadsheet_id,
        range,
        majorDimension: major_dimension,
        valueRenderOption: value_render_option,
        dateTimeRenderOption: date_time_render_option,
      });
      return asText(res.data);
    }
  );

  server.tool("gsheets_values_update_advanced", "Google Sheets: values update advanced. / Google Таблицы: values update advanced.",
    {
      spreadsheet_id: z.string().describe("Input parameter. / Входной параметр."),
      range: z.string().describe("Input parameter. / Входной параметр."),
      values: z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))).describe("Values rows"),
      major_dimension: z.enum(["ROWS", "COLUMNS"]).optional(),
      value_input_option: z.enum(["RAW", "USER_ENTERED"]).optional().default("USER_ENTERED"),
      include_values_in_response: z.boolean().optional().default(false),
      response_value_render_option: z.enum(["FORMATTED_VALUE", "UNFORMATTED_VALUE", "FORMULA"]).optional(),
      response_date_time_render_option: z.enum(["SERIAL_NUMBER", "FORMATTED_STRING"]).optional(),
    },
    async ({
      spreadsheet_id,
      range,
      values,
      major_dimension,
      value_input_option,
      include_values_in_response,
      response_value_render_option,
      response_date_time_render_option,
    }) => {
      const res = await sheets.spreadsheets.values.update({
        spreadsheetId: spreadsheet_id,
        range,
        valueInputOption: value_input_option,
        includeValuesInResponse: include_values_in_response,
        responseValueRenderOption: response_value_render_option,
        responseDateTimeRenderOption: response_date_time_render_option,
        requestBody: {
          majorDimension: major_dimension,
          values,
        },
      });
      return asText(res.data);
    }
  );

  server.tool("gsheets_values_append_advanced", "Google Sheets: values append advanced. / Google Таблицы: values append advanced.",
    {
      spreadsheet_id: z.string().describe("Input parameter. / Входной параметр."),
      range: z.string().describe("Input parameter. / Входной параметр."),
      values: z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))).describe("Input parameter. / Входной параметр."),
      major_dimension: z.enum(["ROWS", "COLUMNS"]).optional(),
      value_input_option: z.enum(["RAW", "USER_ENTERED"]).optional().default("USER_ENTERED"),
      insert_data_option: z.enum(["OVERWRITE", "INSERT_ROWS"]).optional().default("INSERT_ROWS"),
      include_values_in_response: z.boolean().optional().default(false),
      response_value_render_option: z.enum(["FORMATTED_VALUE", "UNFORMATTED_VALUE", "FORMULA"]).optional(),
      response_date_time_render_option: z.enum(["SERIAL_NUMBER", "FORMATTED_STRING"]).optional(),
    },
    async ({
      spreadsheet_id,
      range,
      values,
      major_dimension,
      value_input_option,
      insert_data_option,
      include_values_in_response,
      response_value_render_option,
      response_date_time_render_option,
    }) => {
      const res = await sheets.spreadsheets.values.append({
        spreadsheetId: spreadsheet_id,
        range,
        valueInputOption: value_input_option,
        insertDataOption: insert_data_option,
        includeValuesInResponse: include_values_in_response,
        responseValueRenderOption: response_value_render_option,
        responseDateTimeRenderOption: response_date_time_render_option,
        requestBody: {
          majorDimension: major_dimension,
          values,
        },
      });
      return asText(res.data);
    }
  );

  server.tool("gsheets_values_batch_get_advanced", "Google Sheets: values batch get advanced. / Google Таблицы: values batch get advanced.",
    {
      spreadsheet_id: z.string().describe("Input parameter. / Входной параметр."),
      ranges: z.array(z.string()).min(1).describe("A1 ranges"),
      major_dimension: z.enum(["ROWS", "COLUMNS"]).optional(),
      value_render_option: z.enum(["FORMATTED_VALUE", "UNFORMATTED_VALUE", "FORMULA"]).optional(),
      date_time_render_option: z.enum(["SERIAL_NUMBER", "FORMATTED_STRING"]).optional(),
    },
    async ({ spreadsheet_id, ranges, major_dimension, value_render_option, date_time_render_option }) => {
      const res = await sheets.spreadsheets.values.batchGet({
        spreadsheetId: spreadsheet_id,
        ranges,
        majorDimension: major_dimension,
        valueRenderOption: value_render_option,
        dateTimeRenderOption: date_time_render_option,
      });
      return asText(res.data);
    }
  );

  server.tool("gsheets_values_batch_update_advanced", "Google Sheets: values batch update advanced. / Google Таблицы: values batch update advanced.",
    {
      spreadsheet_id: z.string().describe("Input parameter. / Входной параметр."),
      data: z.array(z.object({
        range: z.string(),
        majorDimension: z.enum(["ROWS", "COLUMNS"]).optional(),
        values: z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))),
      })).min(1).describe("ValueRange objects"),
      value_input_option: z.enum(["RAW", "USER_ENTERED"]).optional().default("USER_ENTERED"),
      include_values_in_response: z.boolean().optional().default(false),
      response_value_render_option: z.enum(["FORMATTED_VALUE", "UNFORMATTED_VALUE", "FORMULA"]).optional(),
      response_date_time_render_option: z.enum(["SERIAL_NUMBER", "FORMATTED_STRING"]).optional(),
    },
    async ({
      spreadsheet_id,
      data,
      value_input_option,
      include_values_in_response,
      response_value_render_option,
      response_date_time_render_option,
    }) => {
      const res = await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: spreadsheet_id,
        requestBody: {
          valueInputOption: value_input_option,
          data,
          includeValuesInResponse: include_values_in_response,
          responseValueRenderOption: response_value_render_option,
          responseDateTimeRenderOption: response_date_time_render_option,
        },
      });
      return asText(res.data);
    }
  );

  server.tool("gsheets_batch_clear_by_data_filter", "Google Sheets: batch operation clear by data filter. / Google Таблицы: пакетная операция clear by data filter.",
    {
      spreadsheet_id: z.string().describe("Input parameter. / Входной параметр."),
      data_filters: z.array(z.record(z.any())).min(1).describe("Input parameter. / Входной параметр."),
    },
    async ({ spreadsheet_id, data_filters }) => {
      const res = await sheets.spreadsheets.values.batchClearByDataFilter({
        spreadsheetId: spreadsheet_id,
        requestBody: { dataFilters: data_filters },
      });
      return asText(res.data);
    }
  );

  server.tool("gsheets_developer_metadata_get", "Google Sheets: developer metadata get. / Google Таблицы: developer метаданные get.",
    {
      spreadsheet_id: z.string().describe("Input parameter. / Входной параметр."),
      metadata_id: z.number().int().describe("Developer metadata numeric ID"),
    },
    async ({ spreadsheet_id, metadata_id }) => {
      const res = await sheets.spreadsheets.developerMetadata.get({
        spreadsheetId: spreadsheet_id,
        metadataId: metadata_id,
      });
      return asText(res.data);
    }
  );

  server.tool("gsheets_developer_metadata_search", "Google Sheets: developer metadata search. / Google Таблицы: developer метаданные search.",
    {
      spreadsheet_id: z.string().describe("Input parameter. / Входной параметр."),
      data_filters: z.array(z.record(z.any())).min(1).describe("Input parameter. / Входной параметр."),
    },
    async ({ spreadsheet_id, data_filters }) => {
      const res = await sheets.spreadsheets.developerMetadata.search({
        spreadsheetId: spreadsheet_id,
        requestBody: { dataFilters: data_filters },
      });
      return asText(res.data);
    }
  );

  server.tool("gsheets_developer_metadata_add", "Google Sheets: developer metadata add. / Google Таблицы: developer метаданные add.",
    {
      spreadsheet_id: z.string().describe("Input parameter. / Входной параметр."),
      developer_metadata: z.record(z.any()).describe("Google Sheets DeveloperMetadata object"),
    },
    async ({ spreadsheet_id, developer_metadata }) => {
      const res = await sheets.spreadsheets.batchUpdate({
        spreadsheetId: spreadsheet_id,
        requestBody: {
          requests: [{ createDeveloperMetadata: { developerMetadata: developer_metadata } }],
        },
      });
      return asText(res.data);
    }
  );

  server.tool("gsheets_developer_metadata_update", "Google Sheets: developer metadata update. / Google Таблицы: developer метаданные update.",
    {
      spreadsheet_id: z.string().describe("Input parameter. / Входной параметр."),
      data_filters: z.array(z.record(z.any())).min(1).describe("Input parameter. / Входной параметр."),
      developer_metadata: z.record(z.any()).describe("Input parameter. / Входной параметр."),
      fields: z.string().describe("Input parameter. / Входной параметр."),
    },
    async ({ spreadsheet_id, data_filters, developer_metadata, fields }) => {
      const res = await sheets.spreadsheets.batchUpdate({
        spreadsheetId: spreadsheet_id,
        requestBody: {
          requests: [{
            updateDeveloperMetadata: {
              dataFilters: data_filters,
              developerMetadata: developer_metadata,
              fields,
            },
          }],
        },
      });
      return asText(res.data);
    }
  );

  server.tool("gsheets_developer_metadata_delete", "Google Sheets: developer metadata delete. / Google Таблицы: developer метаданные delete.",
    {
      spreadsheet_id: z.string().describe("Input parameter. / Входной параметр."),
      data_filters: z.array(z.record(z.any())).min(1).describe("Input parameter. / Входной параметр."),
    },
    async ({ spreadsheet_id, data_filters }) => {
      const res = await sheets.spreadsheets.batchUpdate({
        spreadsheetId: spreadsheet_id,
        requestBody: {
          requests: [{ deleteDeveloperMetadata: { dataFilter: data_filters[0] } }],
        },
      });
      return asText(res.data);
    }
  );

  server.tool("gsheets_auto_resize_dimensions", "Google Sheets: auto resize dimensions. / Google Таблицы: auto resize dimensions.",
    {
      spreadsheet_id: z.string().describe("Input parameter. / Входной параметр."),
      sheet_id: z.number().int().describe("Input parameter. / Входной параметр."),
      dimension: z.enum(["ROWS", "COLUMNS"]),
      start_index: z.number().int().min(0).optional(),
      end_index: z.number().int().min(0).optional(),
    },
    async ({ spreadsheet_id, sheet_id, dimension, start_index, end_index }) => {
      const dimensions: Record<string, number | string> = { sheetId: sheet_id, dimension };
      if (start_index !== undefined) dimensions.startIndex = start_index;
      if (end_index !== undefined) dimensions.endIndex = end_index;
      const res = await sheets.spreadsheets.batchUpdate({
        spreadsheetId: spreadsheet_id,
        requestBody: {
          requests: [{ autoResizeDimensions: { dimensions } }],
        },
      });
      return asText(res.data);
    }
  );

  server.tool("gsheets_update_dimension_properties", "Google Sheets: update dimension properties. / Google Таблицы: обновить dimension properties.",
    {
      spreadsheet_id: z.string().describe("Input parameter. / Входной параметр."),
      sheet_id: z.number().int().describe("Input parameter. / Входной параметр."),
      dimension: z.enum(["ROWS", "COLUMNS"]),
      start_index: z.number().int().min(0).optional(),
      end_index: z.number().int().min(0).optional(),
      properties: z.record(z.any()).describe("DimensionProperties object"),
      fields: z.string().describe("Input parameter. / Входной параметр."),
    },
    async ({ spreadsheet_id, sheet_id, dimension, start_index, end_index, properties, fields }) => {
      const range: Record<string, number | string> = { sheetId: sheet_id, dimension };
      if (start_index !== undefined) range.startIndex = start_index;
      if (end_index !== undefined) range.endIndex = end_index;
      const res = await sheets.spreadsheets.batchUpdate({
        spreadsheetId: spreadsheet_id,
        requestBody: {
          requests: [{ updateDimensionProperties: { range, properties, fields } }],
        },
      });
      return asText(res.data);
    }
  );

  server.tool("gsheets_add_filter_view", "Google Sheets: add filter view. / Google Таблицы: добавить filter view.",
    {
      spreadsheet_id: z.string().describe("Input parameter. / Входной параметр."),
      filter: z.record(z.any()).describe("Google Sheets FilterView object"),
    },
    async ({ spreadsheet_id, filter }) => {
      const res = await sheets.spreadsheets.batchUpdate({
        spreadsheetId: spreadsheet_id,
        requestBody: { requests: [{ addFilterView: { filter } }] },
      });
      return asText(res.data);
    }
  );

  server.tool("gsheets_set_basic_filter", "Google Sheets: set basic filter. / Google Таблицы: set basic filter.",
    {
      spreadsheet_id: z.string().describe("Input parameter. / Входной параметр."),
      filter: z.record(z.any()).describe("Google Sheets BasicFilter object"),
    },
    async ({ spreadsheet_id, filter }) => {
      const res = await sheets.spreadsheets.batchUpdate({
        spreadsheetId: spreadsheet_id,
        requestBody: { requests: [{ setBasicFilter: { filter } }] },
      });
      return asText(res.data);
    }
  );

  server.tool("gsheets_clear_basic_filter", "Google Sheets: clear basic filter. / Google Таблицы: очистить basic filter.",
    {
      spreadsheet_id: z.string().describe("Input parameter. / Входной параметр."),
      sheet_id: z.number().int().describe("Input parameter. / Входной параметр."),
    },
    async ({ spreadsheet_id, sheet_id }) => {
      const res = await sheets.spreadsheets.batchUpdate({
        spreadsheetId: spreadsheet_id,
        requestBody: { requests: [{ clearBasicFilter: { sheetId: sheet_id } }] },
      });
      return asText(res.data);
    }
  );

  server.tool("gsheets_add_conditional_format_rule", "Google Sheets: add conditional format rule. / Google Таблицы: добавить conditional format rule.",
    {
      spreadsheet_id: z.string().describe("Input parameter. / Входной параметр."),
      rule: z.record(z.any()).describe("Google Sheets ConditionalFormatRule object"),
      index: z.number().int().min(0).optional().default(0),
    },
    async ({ spreadsheet_id, rule, index }) => {
      const res = await sheets.spreadsheets.batchUpdate({
        spreadsheetId: spreadsheet_id,
        requestBody: { requests: [{ addConditionalFormatRule: { rule, index } }] },
      });
      return asText(res.data);
    }
  );

  server.tool("gsheets_delete_conditional_format_rule", "Google Sheets: delete conditional format rule. / Google Таблицы: удалить conditional format rule.",
    {
      spreadsheet_id: z.string().describe("Input parameter. / Входной параметр."),
      sheet_id: z.number().int().describe("Input parameter. / Входной параметр."),
      index: z.number().int().min(0).describe("Rule index"),
    },
    async ({ spreadsheet_id, sheet_id, index }) => {
      const res = await sheets.spreadsheets.batchUpdate({
        spreadsheetId: spreadsheet_id,
        requestBody: { requests: [{ deleteConditionalFormatRule: { sheetId: sheet_id, index } }] },
      });
      return asText(res.data);
    }
  );

  server.tool("gsheets_add_chart", "Google Sheets: add chart. / Google Таблицы: добавить chart.",
    {
      spreadsheet_id: z.string().describe("Input parameter. / Входной параметр."),
      chart: z.record(z.any()).describe("Google Sheets EmbeddedChart object"),
    },
    async ({ spreadsheet_id, chart }) => {
      const res = await sheets.spreadsheets.batchUpdate({
        spreadsheetId: spreadsheet_id,
        requestBody: { requests: [{ addChart: { chart } }] },
      });
      return asText(res.data);
    }
  );

  server.tool("gsheets_delete_embedded_object", "Google Sheets: delete embedded object. / Google Таблицы: удалить embedded object.",
    {
      spreadsheet_id: z.string().describe("Input parameter. / Входной параметр."),
      object_id: z.number().int().describe("Embedded object ID"),
    },
    async ({ spreadsheet_id, object_id }) => {
      const res = await sheets.spreadsheets.batchUpdate({
        spreadsheetId: spreadsheet_id,
        requestBody: { requests: [{ deleteEmbeddedObject: { objectId: object_id } }] },
      });
      return asText(res.data);
    }
  );

  server.tool("gdrive_get_file_info", "Google Drive: get file info. / Google Диск: получить файлы info.",
    {
      file_id: z.string().describe("Input parameter. / Входной параметр."),
    },
    async ({ file_id }) => {
      const res = await drive.files.get({ fileId: file_id, fields: "*" });
      return {
        content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }],
      };
    }
  );

  server.tool("workspace_drive_list_files", "Google Workspace: drive list files. / Google Workspace: drive list файлы.",
    {
      query: z.string().optional(),
      folder_id: z.string().optional(),
      page_size: z.number().int().min(1).max(100).optional().default(20),
      page_token: z.string().optional(),
      order_by: z.string().optional().default("modifiedTime desc"),
    },
    async ({ query, folder_id, page_size, page_token, order_by }) => {
      let q = "trashed = false";
      if (folder_id) q += ` and '${folder_id}' in parents`;
      if (query) q += ` and ${query}`;
      const res = await drive.files.list({
        q,
        pageSize: page_size,
        pageToken: page_token,
        orderBy: order_by,
        fields: "nextPageToken, files(id, name, mimeType, size, modifiedTime, parents, webViewLink, owners, driveId)",
      });
      return asText({ files: res.data.files, nextPageToken: res.data.nextPageToken });
    }
  );

  server.tool("workspace_drive_read_file", "Google Workspace: drive read file. / Google Workspace: drive read файлы.",
    {
      file_id: z.string().describe("Input parameter. / Входной параметр."),
      export_format: z.enum(["text", "markdown", "html", "pdf"]).optional().default("text"),
    },
    async ({ file_id, export_format }) => {
      const meta = await drive.files.get({ fileId: file_id, fields: "id, name, mimeType" });
      const mimeType = meta.data.mimeType || "";
      let content = "";
      if (mimeType === "application/vnd.google-apps.document") {
        const exportMime = export_format === "html" ? "text/html" :
          export_format === "markdown" ? "text/markdown" : "text/plain";
        const res = await drive.files.export({ fileId: file_id, mimeType: exportMime }, { responseType: "text" });
        content = res.data as string;
      } else if (mimeType === "application/vnd.google-apps.spreadsheet") {
        const res = await drive.files.export({ fileId: file_id, mimeType: "text/csv" }, { responseType: "text" });
        content = res.data as string;
      } else if (mimeType === "application/vnd.google-apps.presentation") {
        const res = await drive.files.export({ fileId: file_id, mimeType: "text/plain" }, { responseType: "text" });
        content = res.data as string;
      } else {
        const res = await drive.files.get({ fileId: file_id, alt: "media" }, { responseType: "text" });
        content = res.data as string;
      }
      return asText(`File / Файл: ${meta.data.name}\nType / Тип: ${mimeType}\n\n${content}`);
    }
  );

  server.tool("workspace_docs_create_document", "Google Workspace: docs create document. / Google Workspace: docs create document.",
    {
      title: z.string(),
      body_text: z.string().optional(),
      parent_id: z.string().optional(),
    },
    async ({ title, body_text, parent_id }) => {
      const created = await drive.files.create({
        requestBody: {
          name: title,
          mimeType: "application/vnd.google-apps.document",
          parents: parent_id ? [parent_id] : undefined,
        },
        fields: "id,name,webViewLink",
      });
      const documentId = created.data.id!;
      if (body_text) {
        await docs.documents.batchUpdate({
          documentId,
          requestBody: {
            requests: [{
              insertText: {
                location: { index: 1 },
                text: body_text,
              },
            }],
          },
        });
      }
      return asText({ ...created.data, documentId });
    }
  );

  server.tool("workspace_sheets_append_rows", "Google Workspace: sheets append rows. / Google Workspace: sheets append rows.",
    {
      spreadsheet_id: z.string(),
      range: z.string(),
      values: z.array(z.array(z.string())),
    },
    async ({ spreadsheet_id, range, values }) => {
      const res = await sheets.spreadsheets.values.append({
        spreadsheetId: spreadsheet_id,
        range,
        valueInputOption: "USER_ENTERED",
        insertDataOption: "INSERT_ROWS",
        requestBody: { values },
      });
      return asText(res.data);
    }
  );

  server.tool("gslides_create_presentation", "Google Slides: create presentation. / Google Презентации: создать presentation.",
    {
      title: z.string().describe("Input parameter. / Входной параметр."),
      parent_id: z.string().optional().describe("Input parameter. / Входной параметр."),
    },
    async ({ title, parent_id }) => {
      const created = await drive.files.create({
        requestBody: {
          name: title,
          mimeType: "application/vnd.google-apps.presentation",
          parents: parent_id ? [parent_id] : undefined,
        },
        fields: "id,name,webViewLink",
      });
      return asText({ ...created.data, presentationId: created.data.id });
    }
  );

  server.tool("gslides_get_presentation", "Google Slides: get presentation. / Google Презентации: получить presentation.",
    {
      presentation_id: z.string().describe("Input parameter. / Входной параметр."),
    },
    async ({ presentation_id }) => {
      const res = await slides.presentations.get({
        presentationId: presentation_id,
      });
      return asText(res.data);
    }
  );

  server.tool("gslides_batch_update", "Google Slides: batch operation update. / Google Презентации: пакетная операция update.",
    {
      presentation_id: z.string().describe("Input parameter. / Входной параметр."),
      requests: z.array(z.any()).min(1).describe("Input parameter. / Входной параметр."),
    },
    async ({ presentation_id, requests }) => {
      const res = await slides.presentations.batchUpdate({
        presentationId: presentation_id,
        requestBody: { requests },
      });
      return asText(res.data);
    }
  );

  server.tool("workspace_slides_get_presentation", "Google Workspace: slides get presentation. / Google Workspace: slides get presentation.",
    {
      presentation_id: z.string(),
    },
    async ({ presentation_id }) => {
      const res = await slides.presentations.get({
        presentationId: presentation_id,
      });
      return asText(res.data);
    }
  );

  server.tool("gcalendar_list_calendars", "Google Calendar: list calendars. / Google Календарь: получить список календари.",
    {},
    async () => {
      const res = await calendar.calendarList.list();
      return {
        content: [{ type: "text", text: JSON.stringify(res.data.items ?? [], null, 2) }],
      };
    }
  );

  server.tool("gcalendar_list_events", "Google Calendar: list events. / Google Календарь: получить список события.",
    {
      calendar_id: z.string().optional().default("primary").describe("Input parameter. / Входной параметр."),
      time_min: z.string().optional().describe("Input parameter. / Входной параметр."),
      time_max: z.string().optional().describe("Input parameter. / Входной параметр."),
      max_results: z.number().int().min(1).max(250).optional().default(25),
      query: z.string().optional().describe("Input parameter. / Входной параметр."),
      single_events: z.boolean().optional().default(true).describe("Input parameter. / Входной параметр."),
    },
    async ({ calendar_id, time_min, time_max, max_results, query, single_events }) => {
      const res = await calendar.events.list({
        calendarId: calendar_id,
        timeMin: time_min,
        timeMax: time_max,
        q: query,
        maxResults: max_results,
        singleEvents: single_events,
        orderBy: single_events ? "startTime" : undefined,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(res.data.items ?? [], null, 2) }],
      };
    }
  );

  server.tool("gcalendar_get_event", "Google Calendar: get event. / Google Календарь: получить события.",
    {
      calendar_id: z.string().optional().default("primary"),
      event_id: z.string().describe("Input parameter. / Входной параметр."),
    },
    async ({ calendar_id, event_id }) => {
      const res = await calendar.events.get({
        calendarId: calendar_id,
        eventId: event_id,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }],
      };
    }
  );

  server.tool("gcalendar_create_event", "Google Calendar: create event. / Google Календарь: создать события.",
    {
      calendar_id: z.string().optional().default("primary"),
      summary: z.string().describe("Input parameter. / Входной параметр."),
      description: z.string().optional().describe("Input parameter. / Входной параметр."),
      location: z.string().optional().describe("Input parameter. / Входной параметр."),
      start: z.string().describe("Input parameter. / Входной параметр."),
      end: z.string().describe("Input parameter. / Входной параметр."),
      timezone: z.string().optional().describe("Input parameter. / Входной параметр."),
      attendees: z.array(z.string().email()).optional().describe("Input parameter. / Входной параметр."),
    },
    async ({ calendar_id, summary, description, location, start, end, timezone, attendees }) => {
      const res = await calendar.events.insert({
        calendarId: calendar_id,
        requestBody: {
          summary,
          description,
          location,
          start: { dateTime: start, timeZone: timezone },
          end: { dateTime: end, timeZone: timezone },
          attendees: attendees?.map((email) => ({ email })),
        },
      });
      return {
        content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }],
      };
    }
  );

  server.tool("gcalendar_update_event", "Google Calendar: update event. / Google Календарь: обновить события.",
    {
      calendar_id: z.string().optional().default("primary"),
      event_id: z.string().describe("Input parameter. / Входной параметр."),
      summary: z.string().optional(),
      description: z.string().optional(),
      location: z.string().optional(),
      start: z.string().optional().describe("Input parameter. / Входной параметр."),
      end: z.string().optional().describe("Input parameter. / Входной параметр."),
      timezone: z.string().optional(),
      attendees: z.array(z.string().email()).optional(),
      status: z.enum(["confirmed", "tentative", "cancelled"]).optional(),
    },
    async ({ calendar_id, event_id, ...patch }) => {
      const current = await calendar.events.get({ calendarId: calendar_id, eventId: event_id });
      const requestBody: any = {
        ...current.data,
        ...patch,
      };
      if (patch.start) requestBody.start = { dateTime: patch.start, timeZone: patch.timezone ?? current.data.start?.timeZone };
      if (patch.end) requestBody.end = { dateTime: patch.end, timeZone: patch.timezone ?? current.data.end?.timeZone };
      if (patch.attendees) requestBody.attendees = patch.attendees.map((email) => ({ email }));

      const res = await calendar.events.update({
        calendarId: calendar_id,
        eventId: event_id,
        requestBody,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }],
      };
    }
  );

  server.tool("gcalendar_rsvp_event", "Google Calendar: RSVP event. / Google Календарь: ответить на приглашение события.",
    {
      calendar_id: z.string().optional().default("primary"),
      event_id: z.string().describe("Input parameter. / Входной параметр."),
      attendee_email: z.string().email().describe("Input parameter. / Входной параметр."),
      response_status: z.enum(["accepted", "tentative", "declined", "needsAction"]),
    },
    async ({ calendar_id, event_id, attendee_email, response_status }) => {
      const current = await calendar.events.get({ calendarId: calendar_id, eventId: event_id });
      const attendees = (current.data.attendees ?? []).map((a) =>
        a.email?.toLowerCase() === attendee_email.toLowerCase()
          ? { ...a, responseStatus: response_status }
          : a
      );
      const res = await calendar.events.update({
        calendarId: calendar_id,
        eventId: event_id,
        requestBody: {
          ...current.data,
          attendees,
        },
      });
      return asText(res.data);
    }
  );

  server.tool("gcalendar_quick_add", "Google Calendar: quick add add. / Google Календарь: быстро создать add.",
    {
      calendar_id: z.string().optional().default("primary"),
      text: z.string().describe("Input parameter. / Входной параметр."),
    },
    async ({ calendar_id, text }) => {
      const res = await calendar.events.quickAdd({
        calendarId: calendar_id,
        text,
      });
      return asText(res.data);
    }
  );

  server.tool("gcalendar_delete_event", "Google Calendar: delete event. / Google Календарь: удалить события.",
    {
      calendar_id: z.string().optional().default("primary"),
      event_id: z.string().describe("Input parameter. / Входной параметр."),
    },
    async ({ calendar_id, event_id }) => {
      await calendar.events.delete({
        calendarId: calendar_id,
        eventId: event_id,
      });
      return {
        content: [{ type: "text", text: `Event deleted from calendar / Событие удалено из календаря: ${event_id} (${calendar_id})` }],
      };
    }
  );

  server.tool("gcalendar_freebusy", "Google Calendar: check free/busy resource. / Google Календарь: проверить занятость resource.",
    {
      calendar_ids: z.array(z.string()).min(1).describe("Input parameter. / Входной параметр."),
      time_min: z.string().describe("Input parameter. / Входной параметр."),
      time_max: z.string().describe("Input parameter. / Входной параметр."),
      timezone: z.string().optional(),
    },
    async ({ calendar_ids, time_min, time_max, timezone }) => {
      const res = await calendar.freebusy.query({
        requestBody: {
          timeMin: time_min,
          timeMax: time_max,
          timeZone: timezone,
          items: calendar_ids.map((id) => ({ id })),
        },
      });
      return {
        content: [{ type: "text", text: JSON.stringify(res.data.calendars ?? {}, null, 2) }],
      };
    }
  );

  server.tool("gcalendar_get_calendar", "Google Calendar: get calendar. / Google Календарь: получить календари.",
    {
      calendar_id: z.string().optional().default("primary"),
    },
    async ({ calendar_id }) => {
      const res = await calendar.calendars.get({ calendarId: calendar_id });
      return asText(res.data);
    }
  );

  server.tool("gcalendar_create_calendar", "Google Calendar: create calendar. / Google Календарь: создать календари.",
    {
      summary: z.string(),
      description: z.string().optional(),
      location: z.string().optional(),
      time_zone: z.string().optional(),
    },
    async ({ summary, description, location, time_zone }) => {
      const res = await calendar.calendars.insert({
        requestBody: {
          summary,
          description,
          location,
          timeZone: time_zone,
        },
      });
      return asText(res.data);
    }
  );

  server.tool("gcalendar_update_calendar", "Google Calendar: update calendar. / Google Календарь: обновить календари.",
    {
      calendar_id: z.string(),
      calendar: z.record(z.any()).describe("Calendar resource"),
    },
    async ({ calendar_id, calendar: calendarBody }) => {
      const res = await calendar.calendars.update({ calendarId: calendar_id, requestBody: calendarBody });
      return asText(res.data);
    }
  );

  server.tool("gcalendar_patch_calendar", "Google Calendar: patch calendar. / Google Календарь: частично обновить календари.",
    {
      calendar_id: z.string(),
      calendar: z.record(z.any()).describe("Calendar patch"),
    },
    async ({ calendar_id, calendar: calendarBody }) => {
      const res = await calendar.calendars.patch({ calendarId: calendar_id, requestBody: calendarBody });
      return asText(res.data);
    }
  );

  server.tool("gcalendar_clear_calendar", "Google Calendar: clear calendar. / Google Календарь: очистить календари.",
    {
      calendar_id: z.string().optional().default("primary"),
    },
    async ({ calendar_id }) => {
      await calendar.calendars.clear({ calendarId: calendar_id });
      return asText({ cleared: true, calendarId: calendar_id });
    }
  );

  server.tool("gcalendar_delete_calendar", "Google Calendar: delete calendar. / Google Календарь: удалить календари.",
    {
      calendar_id: z.string(),
    },
    async ({ calendar_id }) => {
      await calendar.calendars.delete({ calendarId: calendar_id });
      return asText({ deleted: true, calendarId: calendar_id });
    }
  );

  server.tool("gcalendar_get_calendar_list_entry", "Google Calendar: get calendar list entry. / Google Календарь: получить календари list entry.",
    {
      calendar_id: z.string(),
    },
    async ({ calendar_id }) => {
      const res = await calendar.calendarList.get({ calendarId: calendar_id });
      return asText(res.data);
    }
  );

  server.tool("gcalendar_insert_calendar_list_entry", "Google Calendar: insert calendar list entry. / Google Календарь: вставить календари list entry.",
    {
      calendar_id: z.string(),
      color_rgb_format: z.boolean().optional(),
      entry: z.record(z.any()).optional().default({}),
    },
    async ({ calendar_id, color_rgb_format, entry }) => {
      const res = await calendar.calendarList.insert({
        colorRgbFormat: color_rgb_format,
        requestBody: { id: calendar_id, ...entry },
      });
      return asText(res.data);
    }
  );

  server.tool("gcalendar_update_calendar_list_entry", "Google Calendar: update calendar list entry. / Google Календарь: обновить календари list entry.",
    {
      calendar_id: z.string(),
      entry: z.record(z.any()).describe("CalendarListEntry resource"),
      color_rgb_format: z.boolean().optional(),
    },
    async ({ calendar_id, entry, color_rgb_format }) => {
      const res = await calendar.calendarList.update({
        calendarId: calendar_id,
        colorRgbFormat: color_rgb_format,
        requestBody: entry,
      });
      return asText(res.data);
    }
  );

  server.tool("gcalendar_patch_calendar_list_entry", "Google Calendar: patch calendar list entry. / Google Календарь: частично обновить календари list entry.",
    {
      calendar_id: z.string(),
      entry: z.record(z.any()).describe("CalendarListEntry patch"),
      color_rgb_format: z.boolean().optional(),
    },
    async ({ calendar_id, entry, color_rgb_format }) => {
      const res = await calendar.calendarList.patch({
        calendarId: calendar_id,
        colorRgbFormat: color_rgb_format,
        requestBody: entry,
      });
      return asText(res.data);
    }
  );

  server.tool("gcalendar_delete_calendar_list_entry", "Google Calendar: delete calendar list entry. / Google Календарь: удалить календари list entry.",
    {
      calendar_id: z.string(),
    },
    async ({ calendar_id }) => {
      await calendar.calendarList.delete({ calendarId: calendar_id });
      return asText({ deleted: true, calendarId: calendar_id });
    }
  );

  server.tool("gcalendar_watch_calendar_list", "Google Calendar: watch changes calendar list. / Google Календарь: отслеживать изменения календари list.",
    {
      channel: z.record(z.any()).describe("Channel object: id,type,address,token,expiration..."),
    },
    async ({ channel }) => {
      const res = await calendar.calendarList.watch({ requestBody: channel });
      return asText(res.data);
    }
  );

  server.tool("gcalendar_get_colors", "Google Calendar: get colors. / Google Календарь: получить colors.",
    {},
    async () => {
      const res = await calendar.colors.get();
      return asText(res.data);
    }
  );

  server.tool("gcalendar_list_acl", "Google Calendar: list acl. / Google Календарь: получить список acl.",
    {
      calendar_id: z.string().optional().default("primary"),
      max_results: z.number().int().min(1).max(250).optional().default(100),
      page_token: z.string().optional(),
      sync_token: z.string().optional(),
      show_deleted: z.boolean().optional(),
    },
    async ({ calendar_id, max_results, page_token, sync_token, show_deleted }) => {
      const res = await calendar.acl.list({
        calendarId: calendar_id,
        maxResults: max_results,
        pageToken: page_token,
        syncToken: sync_token,
        showDeleted: show_deleted,
      });
      return asText(res.data);
    }
  );

  server.tool("gcalendar_get_acl_rule", "Google Calendar: get acl rule. / Google Календарь: получить acl rule.",
    {
      calendar_id: z.string().optional().default("primary"),
      rule_id: z.string(),
    },
    async ({ calendar_id, rule_id }) => {
      const res = await calendar.acl.get({ calendarId: calendar_id, ruleId: rule_id });
      return asText(res.data);
    }
  );

  server.tool("gcalendar_create_acl_rule", "Google Calendar: create acl rule. / Google Календарь: создать acl rule.",
    {
      calendar_id: z.string().optional().default("primary"),
      role: z.enum(["none", "freeBusyReader", "reader", "writer", "owner"]),
      scope_type: z.enum(["default", "user", "group", "domain"]),
      scope_value: z.string().optional(),
      send_notifications: z.boolean().optional(),
    },
    async ({ calendar_id, role, scope_type, scope_value, send_notifications }) => {
      const res = await calendar.acl.insert({
        calendarId: calendar_id,
        sendNotifications: send_notifications,
        requestBody: {
          role,
          scope: { type: scope_type, value: scope_value },
        },
      });
      return asText(res.data);
    }
  );

  server.tool("gcalendar_update_acl_rule", "Google Calendar: update acl rule. / Google Календарь: обновить acl rule.",
    {
      calendar_id: z.string().optional().default("primary"),
      rule_id: z.string(),
      rule: z.record(z.any()).describe("ACL rule resource"),
      send_notifications: z.boolean().optional(),
    },
    async ({ calendar_id, rule_id, rule, send_notifications }) => {
      const res = await calendar.acl.update({
        calendarId: calendar_id,
        ruleId: rule_id,
        sendNotifications: send_notifications,
        requestBody: rule,
      });
      return asText(res.data);
    }
  );

  server.tool("gcalendar_patch_acl_rule", "Google Calendar: patch acl rule. / Google Календарь: частично обновить acl rule.",
    {
      calendar_id: z.string().optional().default("primary"),
      rule_id: z.string(),
      rule: z.record(z.any()).describe("ACL rule patch"),
      send_notifications: z.boolean().optional(),
    },
    async ({ calendar_id, rule_id, rule, send_notifications }) => {
      const res = await calendar.acl.patch({
        calendarId: calendar_id,
        ruleId: rule_id,
        sendNotifications: send_notifications,
        requestBody: rule,
      });
      return asText(res.data);
    }
  );

  server.tool("gcalendar_delete_acl_rule", "Google Calendar: delete acl rule. / Google Календарь: удалить acl rule.",
    {
      calendar_id: z.string().optional().default("primary"),
      rule_id: z.string(),
    },
    async ({ calendar_id, rule_id }) => {
      await calendar.acl.delete({ calendarId: calendar_id, ruleId: rule_id });
      return asText({ deleted: true, calendarId: calendar_id, ruleId: rule_id });
    }
  );

  server.tool("gcalendar_watch_acl", "Google Calendar: watch changes acl. / Google Календарь: отслеживать изменения acl.",
    {
      calendar_id: z.string().optional().default("primary"),
      channel: z.record(z.any()).describe("Channel object: id,type,address,token,expiration..."),
    },
    async ({ calendar_id, channel }) => {
      const res = await calendar.acl.watch({ calendarId: calendar_id, requestBody: channel });
      return asText(res.data);
    }
  );

  server.tool("gcalendar_patch_event", "Google Calendar: patch event. / Google Календарь: частично обновить события.",
    {
      calendar_id: z.string().optional().default("primary"),
      event_id: z.string(),
      event: z.record(z.any()).describe("Event patch"),
      send_updates: z.enum(["all", "externalOnly", "none"]).optional(),
      conference_data_version: z.number().int().optional(),
    },
    async ({ calendar_id, event_id, event, send_updates, conference_data_version }) => {
      const res = await calendar.events.patch({
        calendarId: calendar_id,
        eventId: event_id,
        sendUpdates: send_updates,
        conferenceDataVersion: conference_data_version,
        requestBody: event,
      });
      return asText(res.data);
    }
  );

  server.tool("gcalendar_import_event", "Google Calendar: import event. / Google Календарь: импортировать события.",
    {
      calendar_id: z.string().optional().default("primary"),
      event: z.record(z.any()).describe("Event resource to import"),
      conference_data_version: z.number().int().optional(),
      supports_attachments: z.boolean().optional(),
    },
    async ({ calendar_id, event, conference_data_version, supports_attachments }) => {
      const res = await calendar.events.import({
        calendarId: calendar_id,
        conferenceDataVersion: conference_data_version,
        supportsAttachments: supports_attachments,
        requestBody: event,
      });
      return asText(res.data);
    }
  );

  server.tool("gcalendar_list_event_instances", "Google Calendar: list event instances. / Google Календарь: получить список события instances.",
    {
      calendar_id: z.string().optional().default("primary"),
      event_id: z.string(),
      time_min: z.string().optional(),
      time_max: z.string().optional(),
      max_results: z.number().int().min(1).max(2500).optional().default(250),
      page_token: z.string().optional(),
      show_deleted: z.boolean().optional(),
      timezone: z.string().optional(),
    },
    async ({ calendar_id, event_id, time_min, time_max, max_results, page_token, show_deleted, timezone }) => {
      const res = await calendar.events.instances({
        calendarId: calendar_id,
        eventId: event_id,
        timeMin: time_min,
        timeMax: time_max,
        maxResults: max_results,
        pageToken: page_token,
        showDeleted: show_deleted,
        timeZone: timezone,
      });
      return asText(res.data);
    }
  );

  server.tool("gcalendar_move_event", "Google Calendar: move event. / Google Календарь: переместить события.",
    {
      source_calendar_id: z.string().optional().default("primary"),
      event_id: z.string(),
      destination_calendar_id: z.string(),
      send_updates: z.enum(["all", "externalOnly", "none"]).optional(),
    },
    async ({ source_calendar_id, event_id, destination_calendar_id, send_updates }) => {
      const res = await calendar.events.move({
        calendarId: source_calendar_id,
        eventId: event_id,
        destination: destination_calendar_id,
        sendUpdates: send_updates,
      });
      return asText(res.data);
    }
  );

  server.tool("gcalendar_watch_events", "Google Calendar: watch changes events. / Google Календарь: отслеживать изменения события.",
    {
      calendar_id: z.string().optional().default("primary"),
      channel: z.record(z.any()).describe("Channel object: id,type,address,token,expiration..."),
      time_min: z.string().optional(),
      time_max: z.string().optional(),
      single_events: z.boolean().optional(),
      sync_token: z.string().optional(),
    },
    async ({ calendar_id, channel, time_min, time_max, single_events, sync_token }) => {
      const res = await calendar.events.watch({
        calendarId: calendar_id,
        timeMin: time_min,
        timeMax: time_max,
        singleEvents: single_events,
        syncToken: sync_token,
        requestBody: channel,
      });
      return asText(res.data);
    }
  );

  server.tool("gcalendar_stop_channel", "Google Calendar: stop channel channel. / Google Календарь: остановить канал channel.",
    {
      channel: z.record(z.any()).describe("Channel object with id and resourceId"),
    },
    async ({ channel }) => {
      await calendar.channels.stop({ requestBody: channel });
      return asText({ stopped: true, channel });
    }
  );

  server.tool("gcalendar_list_settings", "Google Calendar: list settings. / Google Календарь: получить список настройки.",
    {
      max_results: z.number().int().min(1).max(250).optional().default(100),
      page_token: z.string().optional(),
      sync_token: z.string().optional(),
    },
    async ({ max_results, page_token, sync_token }) => {
      const res = await calendar.settings.list({
        maxResults: max_results,
        pageToken: page_token,
        syncToken: sync_token,
      });
      return asText(res.data);
    }
  );

  server.tool("gcalendar_get_setting", "Google Calendar: get setting. / Google Календарь: получить setting.",
    {
      setting_id: z.string(),
    },
    async ({ setting_id }) => {
      const res = await calendar.settings.get({ setting: setting_id });
      return asText(res.data);
    }
  );

  server.tool("gcalendar_watch_settings", "Google Calendar: watch changes settings. / Google Календарь: отслеживать изменения настройки.",
    {
      channel: z.record(z.any()).describe("Channel object: id,type,address,token,expiration..."),
    },
    async ({ channel }) => {
      const res = await calendar.settings.watch({ requestBody: channel });
      return asText(res.data);
    }
  );

  server.tool("workspace_calendar_list_events", "Google Workspace: calendar list events. / Google Workspace: calendar list события.",
    {
      calendar_id: z.string().optional().default("primary"),
      time_min: z.string().optional(),
      time_max: z.string().optional(),
      max_results: z.number().int().min(1).max(250).optional().default(25),
      query: z.string().optional(),
      single_events: z.boolean().optional().default(true),
    },
    async ({ calendar_id, time_min, time_max, max_results, query, single_events }) => {
      const res = await calendar.events.list({
        calendarId: calendar_id,
        timeMin: time_min,
        timeMax: time_max,
        q: query,
        maxResults: max_results,
        singleEvents: single_events,
        orderBy: single_events ? "startTime" : undefined,
      });
      return asText(res.data.items ?? []);
    }
  );

  server.tool("gtasks_list_lists", "Google Tasks: list lists. / Google Задачи: получить список lists.",
    {
      max_results: z.number().int().min(1).max(100).optional().default(50),
    },
    async ({ max_results }) => {
      const res = await tasks.tasklists.list({ maxResults: max_results });
      return {
        content: [{ type: "text", text: JSON.stringify(res.data.items ?? [], null, 2) }],
      };
    }
  );

  server.tool("gtasks_create_list", "Google Tasks: create list. / Google Задачи: создать list.",
    {
      title: z.string().describe("Input parameter. / Входной параметр."),
    },
    async ({ title }) => {
      const res = await tasks.tasklists.insert({
        requestBody: { title },
      });
      return {
        content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }],
      };
    }
  );

  server.tool("gtasks_list_tasks", "Google Tasks: list tasks. / Google Задачи: получить список tasks.",
    {
      tasklist_id: z.string().describe("Input parameter. / Входной параметр."),
      show_completed: z.boolean().optional().default(true),
      show_hidden: z.boolean().optional().default(false),
      show_deleted: z.boolean().optional().default(false),
      max_results: z.number().int().min(1).max(100).optional().default(100),
    },
    async ({ tasklist_id, show_completed, show_hidden, show_deleted, max_results }) => {
      const res = await tasks.tasks.list({
        tasklist: tasklist_id,
        showCompleted: show_completed,
        showHidden: show_hidden,
        showDeleted: show_deleted,
        maxResults: max_results,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(res.data.items ?? [], null, 2) }],
      };
    }
  );

  server.tool("gtasks_create_task", "Google Tasks: create task. / Google Задачи: создать task.",
    {
      tasklist_id: z.string().describe("Input parameter. / Входной параметр."),
      title: z.string().describe("Input parameter. / Входной параметр."),
      notes: z.string().optional().describe("Input parameter. / Входной параметр."),
      due: z.string().optional().describe("Input parameter. / Входной параметр."),
      parent_id: z.string().optional().describe("Input parameter. / Входной параметр."),
      previous_id: z.string().optional().describe("Input parameter. / Входной параметр."),
    },
    async ({ tasklist_id, title, notes, due, parent_id, previous_id }) => {
      const res = await tasks.tasks.insert({
        tasklist: tasklist_id,
        parent: parent_id,
        previous: previous_id,
        requestBody: {
          title,
          notes,
          due,
        },
      });
      return {
        content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }],
      };
    }
  );

  server.tool("gtasks_update_task", "Google Tasks: update task. / Google Задачи: обновить task.",
    {
      tasklist_id: z.string().describe("Input parameter. / Входной параметр."),
      task_id: z.string().describe("Input parameter. / Входной параметр."),
      title: z.string().optional(),
      notes: z.string().optional(),
      due: z.string().optional(),
      status: z.enum(["needsAction", "completed"]).optional(),
    },
    async ({ tasklist_id, task_id, ...patch }) => {
      const current = await tasks.tasks.get({
        tasklist: tasklist_id,
        task: task_id,
      });
      const res = await tasks.tasks.update({
        tasklist: tasklist_id,
        task: task_id,
        requestBody: {
          ...current.data,
          ...patch,
          completed: patch.status === "completed" ? new Date().toISOString() : current.data.completed,
        },
      });
      return {
        content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }],
      };
    }
  );

  server.tool("gtasks_complete_task", "Google Tasks: complete task. / Google Задачи: complete task.",
    {
      tasklist_id: z.string().describe("Input parameter. / Входной параметр."),
      task_id: z.string().describe("Input parameter. / Входной параметр."),
    },
    async ({ tasklist_id, task_id }) => {
      const current = await tasks.tasks.get({
        tasklist: tasklist_id,
        task: task_id,
      });
      const res = await tasks.tasks.update({
        tasklist: tasklist_id,
        task: task_id,
        requestBody: {
          ...current.data,
          status: "completed",
          completed: new Date().toISOString(),
        },
      });
      return {
        content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }],
      };
    }
  );

  server.tool("gtasks_delete_task", "Google Tasks: delete task. / Google Задачи: удалить task.",
    {
      tasklist_id: z.string().describe("Input parameter. / Входной параметр."),
      task_id: z.string().describe("Input parameter. / Входной параметр."),
    },
    async ({ tasklist_id, task_id }) => {
      await tasks.tasks.delete({
        tasklist: tasklist_id,
        task: task_id,
      });
      return {
        content: [{ type: "text", text: `Task deleted / Задача удалена: ${task_id}` }],
      };
    }
  );

  server.tool("workspace_tasks_list_tasks", "Google Workspace: tasks list tasks. / Google Workspace: tasks list tasks.",
    {
      tasklist_id: z.string().describe("Input parameter. / Входной параметр."),
      show_completed: z.boolean().optional().default(true),
      show_hidden: z.boolean().optional().default(false),
      show_deleted: z.boolean().optional().default(false),
      max_results: z.number().int().min(1).max(100).optional().default(100),
    },
    async ({ tasklist_id, show_completed, show_hidden, show_deleted, max_results }) => {
      const res = await tasks.tasks.list({
        tasklist: tasklist_id,
        showCompleted: show_completed,
        showHidden: show_hidden,
        showDeleted: show_deleted,
        maxResults: max_results,
      });
      return asText(res.data.items ?? []);
    }
  );

  server.tool("gmail_list_labels", "Gmail: list labels. / Gmail: получить список ярлыки.",
    {},
    async () => {
      const res = await gmail.users.labels.list({ userId: "me" });
      return asText(res.data.labels ?? []);
    }
  );

  server.tool("gmail_list_messages", "Gmail: list messages. / Gmail: получить список письма.",
    {
      query: z.string().optional().describe("Input parameter. / Входной параметр."),
      max_results: z.number().int().min(1).max(100).optional().default(20),
      page_token: z.string().optional(),
      label_ids: z.array(z.string()).optional(),
    },
    async ({ query, max_results, page_token, label_ids }) => {
      const res = await gmail.users.messages.list({
        userId: "me",
        q: query,
        maxResults: max_results,
        pageToken: page_token,
        labelIds: label_ids,
      });
      return asText({
        messages: res.data.messages ?? [],
        nextPageToken: res.data.nextPageToken,
        resultSizeEstimate: res.data.resultSizeEstimate,
      });
    }
  );

  server.tool("gmail_get_message", "Gmail: get message. / Gmail: получить письма.",
    {
      message_id: z.string().describe("ID Gmail message"),
      format: z.enum(["full", "metadata", "raw"]).optional().default("full"),
    },
    async ({ message_id, format }) => {
      const res = await gmail.users.messages.get({
        userId: "me",
        id: message_id,
        format,
      });
      const body = format === "full" ? extractGmailBody(res.data.payload) : "";
      return asText({
        id: res.data.id,
        threadId: res.data.threadId,
        labelIds: res.data.labelIds,
        snippet: res.data.snippet,
        internalDate: res.data.internalDate,
        headers: res.data.payload?.headers ?? [],
        body,
        attachments: listGmailAttachments(res.data.payload),
        raw: format === "raw" ? res.data.raw : undefined,
      });
    }
  );

  server.tool("gmail_list_attachments", "Gmail: list attachments. / Gmail: получить список вложения.",
    {
      message_id: z.string().describe("ID Gmail message"),
    },
    async ({ message_id }) => {
      const res = await gmail.users.messages.get({
        userId: "me",
        id: message_id,
        format: "full",
      });
      return asText({
        messageId: res.data.id,
        threadId: res.data.threadId,
        attachments: listGmailAttachments(res.data.payload),
      });
    }
  );

  server.tool("gmail_download_attachment", "Gmail: download attachment. / Gmail: скачать вложения.",
    {
      message_id: z.string().describe("ID Gmail message"),
      attachment_id: z.string().describe("Input parameter. / Входной параметр."),
      filename: z.string().optional().describe("Input parameter. / Входной параметр."),
      mime_type: z.string().optional().describe("Input parameter. / Входной параметр."),
    },
    async ({ message_id, attachment_id, filename, mime_type }) => {
      const res = await gmail.users.messages.attachments.get({
        userId: "me",
        messageId: message_id,
        id: attachment_id,
      });
      const data = res.data.data ? Buffer.from(res.data.data.replace(/-/g, "+").replace(/_/g, "/"), "base64") : Buffer.alloc(0);
      return asText({
        messageId: message_id,
        attachmentId: attachment_id,
        filename: filename || null,
        mimeType: mime_type || null,
        size: data.length,
        contentBase64: data.toString("base64"),
      });
    }
  );

  server.tool("gmail_create_draft", "Gmail: create draft. / Gmail: создать черновики.",
    {
      to: z.string().describe("Input parameter. / Входной параметр."),
      subject: z.string().describe("Input parameter. / Входной параметр."),
      body: z.string().describe("Input parameter. / Входной параметр."),
      cc: z.string().optional().describe("Input parameter. / Входной параметр."),
      bcc: z.string().optional().describe("Input parameter. / Входной параметр."),
    },
    async ({ to, subject, body, cc, bcc }) => {
      const mime = [
        `To: ${to}`,
        cc ? `Cc: ${cc}` : undefined,
        bcc ? `Bcc: ${bcc}` : undefined,
        "Content-Type: text/plain; charset=utf-8",
        "MIME-Version: 1.0",
        `Subject: ${subject}`,
        "",
        body,
      ].filter(Boolean).join("\r\n");
      const raw = Buffer.from(mime).toString("base64url");
      const res = await gmail.users.drafts.create({
        userId: "me",
        requestBody: { message: { raw } },
      });
      return asText(res.data);
    }
  );

  server.tool("gmail_create_draft_with_attachments", "Gmail: create draft with attachments. / Gmail: создать черновики with вложения.",
    {
      to: z.string().describe("Input parameter. / Входной параметр."),
      subject: z.string().describe("Input parameter. / Входной параметр."),
      body: z.string().describe("Input parameter. / Входной параметр."),
      cc: z.string().optional().describe("Input parameter. / Входной параметр."),
      bcc: z.string().optional().describe("Input parameter. / Входной параметр."),
      attachments: z.array(z.object({
        filename: z.string(),
        mime_type: z.string().optional(),
        content_base64: z.string(),
      })).min(1),
    },
    async ({ to, subject, body, cc, bcc, attachments }) => {
      const raw = encodeBase64Url(buildMimeMessage({ to, subject, body, cc, bcc, attachments }));
      const res = await gmail.users.drafts.create({
        userId: "me",
        requestBody: { message: { raw } },
      });
      return asText(res.data);
    }
  );

  server.tool("gmail_update_draft", "Gmail: update draft. / Gmail: обновить черновики.",
    {
      draft_id: z.string().describe("ID draft"),
      to: z.string().describe("Input parameter. / Входной параметр."),
      subject: z.string().describe("Input parameter. / Входной параметр."),
      body: z.string().describe("Input parameter. / Входной параметр."),
      cc: z.string().optional().describe("Input parameter. / Входной параметр."),
      bcc: z.string().optional().describe("Input parameter. / Входной параметр."),
    },
    async ({ draft_id, to, subject, body, cc, bcc }) => {
      const mime = [
        `To: ${to}`,
        cc ? `Cc: ${cc}` : undefined,
        bcc ? `Bcc: ${bcc}` : undefined,
        "Content-Type: text/plain; charset=utf-8",
        "MIME-Version: 1.0",
        `Subject: ${subject}`,
        "",
        body,
      ].filter(Boolean).join("\r\n");
      const raw = Buffer.from(mime).toString("base64url");
      const res = await gmail.users.drafts.update({
        userId: "me",
        id: draft_id,
        requestBody: {
          id: draft_id,
          message: { raw },
        },
      });
      return asText(res.data);
    }
  );

  server.tool("gmail_list_threads", "Gmail: list threads. / Gmail: получить список цепочки.",
    {
      query: z.string().optional(),
      max_results: z.number().int().min(1).max(100).optional().default(20),
      page_token: z.string().optional(),
      label_ids: z.array(z.string()).optional(),
    },
    async ({ query, max_results, page_token, label_ids }) => {
      const res = await gmail.users.threads.list({
        userId: "me",
        q: query,
        maxResults: max_results,
        pageToken: page_token,
        labelIds: label_ids,
      });
      return asText({
        threads: res.data.threads ?? [],
        nextPageToken: res.data.nextPageToken,
        resultSizeEstimate: res.data.resultSizeEstimate,
      });
    }
  );

  server.tool("gmail_reply_to_message", "Gmail: reply to message. / Gmail: ответить to письма.",
    {
      message_id: z.string().describe("Input parameter. / Входной параметр."),
      body: z.string().describe("Input parameter. / Входной параметр."),
      reply_all: z.boolean().optional().default(false),
    },
    async ({ message_id, body, reply_all }) => {
      const original = await gmail.users.messages.get({
        userId: "me",
        id: message_id,
        format: "metadata",
        metadataHeaders: ["From", "To", "Cc", "Subject", "Message-ID", "References", "In-Reply-To"],
      });
      const headers = extractGmailHeaders(original.data.payload);
      const to = reply_all ? [headers["from"], headers["to"]].filter(Boolean).join(", ") : headers["from"];
      const cc = reply_all ? headers["cc"] : undefined;
      const subject = headers["subject"]?.startsWith("Re:") ? headers["subject"] : `Re: ${headers["subject"] ?? ""}`.trim();
      const refs = [headers["references"], headers["message-id"]].filter(Boolean).join(" ").trim();

      const mime = [
        `To: ${to}`,
        cc ? `Cc: ${cc}` : undefined,
        "Content-Type: text/plain; charset=utf-8",
        "MIME-Version: 1.0",
        `Subject: ${subject}`,
        headers["message-id"] ? `In-Reply-To: ${headers["message-id"]}` : undefined,
        refs ? `References: ${refs}` : undefined,
        "",
        body,
      ].filter(Boolean).join("\r\n");
      const raw = Buffer.from(mime).toString("base64url");

      const res = await gmail.users.messages.send({
        userId: "me",
        requestBody: {
          raw,
          threadId: original.data.threadId ?? undefined,
        },
      });
      return asText(res.data);
    }
  );

  server.tool("gmail_get_thread", "Gmail: get thread. / Gmail: получить цепочки.",
    {
      thread_id: z.string().describe("ID thread"),
    },
    async ({ thread_id }) => {
      const res = await gmail.users.threads.get({
        userId: "me",
        id: thread_id,
        format: "full",
      });
      const messages = (res.data.messages ?? []).map((m) => ({
        id: m.id,
        snippet: m.snippet,
        labelIds: m.labelIds,
        headers: extractGmailHeaders(m.payload),
        body: extractGmailBody(m.payload),
      }));
      return asText({
        id: res.data.id,
        historyId: res.data.historyId,
        messages,
      });
    }
  );

  server.tool("gmail_modify_labels", "Gmail: modify labels. / Gmail: изменить ярлыки.",
    {
      message_id: z.string().describe("Input parameter. / Входной параметр."),
      add_label_ids: z.array(z.string()).optional(),
      remove_label_ids: z.array(z.string()).optional(),
    },
    async ({ message_id, add_label_ids, remove_label_ids }) => {
      const res = await gmail.users.messages.modify({
        userId: "me",
        id: message_id,
        requestBody: {
          addLabelIds: add_label_ids,
          removeLabelIds: remove_label_ids,
        },
      });
      return asText(res.data);
    }
  );

  server.tool("gmail_archive_message", "Gmail: archive message. / Gmail: архивировать письма.",
    {
      message_id: z.string().describe("Input parameter. / Входной параметр."),
    },
    async ({ message_id }) => {
      const res = await gmail.users.messages.modify({
        userId: "me",
        id: message_id,
        requestBody: {
          removeLabelIds: ["INBOX"],
        },
      });
      return asText(res.data);
    }
  );

  server.tool("gmail_trash_message", "Gmail: move to trash message. / Gmail: переместить в корзину письма.",
    {
      message_id: z.string().describe("Input parameter. / Входной параметр."),
    },
    async ({ message_id }) => {
      const res = await gmail.users.messages.trash({
        userId: "me",
        id: message_id,
      });
      return asText(res.data);
    }
  );

  server.tool("gmail_untrash_message", "Gmail: restore from trash message. / Gmail: восстановить из корзины письма.",
    {
      message_id: z.string().describe("Input parameter. / Входной параметр."),
    },
    async ({ message_id }) => {
      const res = await gmail.users.messages.untrash({
        userId: "me",
        id: message_id,
      });
      return asText(res.data);
    }
  );

  server.tool("gmail_create_label", "Gmail: create label. / Gmail: создать ярлыки.",
    {
      name: z.string().describe("Input parameter. / Входной параметр."),
      label_list_visibility: z.enum(["labelShow", "labelShowIfUnread", "labelHide"]).optional(),
      message_list_visibility: z.enum(["show", "hide"]).optional(),
    },
    async ({ name, label_list_visibility, message_list_visibility }) => {
      const res = await gmail.users.labels.create({
        userId: "me",
        requestBody: {
          name,
          labelListVisibility: label_list_visibility,
          messageListVisibility: message_list_visibility,
        },
      });
      return asText(res.data);
    }
  );

  server.tool("gmail_get_profile", "Gmail: get profile. / Gmail: получить proфайлы.",
    {},
    async () => {
      const res = await gmail.users.getProfile({ userId: "me" });
      return asText(res.data);
    }
  );

  server.tool("gmail_history_list", "Gmail: history list. / Gmail: history list.",
    {
      start_history_id: z.string().describe("startHistoryId"),
      max_results: z.number().int().min(1).max(500).optional().default(100),
      page_token: z.string().optional(),
      label_id: z.string().optional(),
      history_types: z.array(z.enum(["messageAdded", "messageDeleted", "labelAdded", "labelRemoved"])).optional(),
    },
    async ({ start_history_id, max_results, page_token, label_id, history_types }) => {
      const res = await gmail.users.history.list({
        userId: "me",
        startHistoryId: start_history_id,
        maxResults: max_results,
        pageToken: page_token,
        labelId: label_id,
        historyTypes: history_types,
      });
      return asText(res.data);
    }
  );

  server.tool("gmail_batch_modify_messages", "Gmail: batch operation modify messages. / Gmail: пакетная операция modify письма.",
    {
      message_ids: z.array(z.string()).min(1).max(1000),
      add_label_ids: z.array(z.string()).optional(),
      remove_label_ids: z.array(z.string()).optional(),
    },
    async ({ message_ids, add_label_ids, remove_label_ids }) => {
      await gmail.users.messages.batchModify({
        userId: "me",
        requestBody: {
          ids: message_ids,
          addLabelIds: add_label_ids,
          removeLabelIds: remove_label_ids,
        },
      });
      return asText({ modified: true, count: message_ids.length });
    }
  );

  server.tool("gmail_batch_delete_messages", "Gmail: batch operation delete messages. / Gmail: пакетная операция delete письма.",
    {
      message_ids: z.array(z.string()).min(1).max(1000),
    },
    async ({ message_ids }) => {
      await gmail.users.messages.batchDelete({ userId: "me", requestBody: { ids: message_ids } });
      return asText({ deleted: true, count: message_ids.length });
    }
  );

  server.tool("gmail_delete_message_permanently", "Gmail: delete message permanently. / Gmail: удалить письма permanently.",
    {
      message_id: z.string(),
    },
    async ({ message_id }) => {
      await gmail.users.messages.delete({ userId: "me", id: message_id });
      return asText({ deleted: true, messageId: message_id });
    }
  );

  server.tool("gmail_insert_raw_message", "Gmail: insert raw message. / Gmail: вставить raw письма.",
    {
      raw_base64url: z.string().describe("RFC 2822 MIME message encoded base64url"),
      label_ids: z.array(z.string()).optional(),
      internal_date_source: z.enum(["dateHeader", "receivedTime"]).optional(),
      deleted: z.boolean().optional(),
    },
    async ({ raw_base64url, label_ids, internal_date_source, deleted }) => {
      const res = await gmail.users.messages.insert({
        userId: "me",
        internalDateSource: internal_date_source,
        deleted,
        requestBody: { raw: raw_base64url, labelIds: label_ids },
      });
      return asText(res.data);
    }
  );

  server.tool("gmail_import_raw_message", "Gmail: import raw message. / Gmail: импортировать raw письма.",
    {
      raw_base64url: z.string().describe("RFC 2822 MIME message encoded base64url"),
      label_ids: z.array(z.string()).optional(),
      internal_date_source: z.enum(["dateHeader", "receivedTime"]).optional(),
      never_mark_spam: z.boolean().optional(),
      process_for_calendar: z.boolean().optional(),
      deleted: z.boolean().optional(),
    },
    async ({ raw_base64url, label_ids, internal_date_source, never_mark_spam, process_for_calendar, deleted }) => {
      const res = await gmail.users.messages.import({
        userId: "me",
        internalDateSource: internal_date_source,
        neverMarkSpam: never_mark_spam,
        processForCalendar: process_for_calendar,
        deleted,
        requestBody: { raw: raw_base64url, labelIds: label_ids },
      });
      return asText(res.data);
    }
  );

  server.tool("gmail_list_drafts", "Gmail: list drafts. / Gmail: получить список черновики.",
    {
      max_results: z.number().int().min(1).max(100).optional().default(20),
      page_token: z.string().optional(),
      query: z.string().optional(),
    },
    async ({ max_results, page_token, query }) => {
      const res = await gmail.users.drafts.list({
        userId: "me",
        maxResults: max_results,
        pageToken: page_token,
        q: query,
      });
      return asText(res.data);
    }
  );

  server.tool("gmail_get_draft", "Gmail: get draft. / Gmail: получить черновики.",
    {
      draft_id: z.string(),
      format: z.enum(["minimal", "full", "metadata", "raw"]).optional().default("full"),
    },
    async ({ draft_id, format }) => {
      const res = await gmail.users.drafts.get({ userId: "me", id: draft_id, format });
      return asText(res.data);
    }
  );

  server.tool("gmail_delete_draft", "Gmail: delete draft. / Gmail: удалить черновики.",
    {
      draft_id: z.string(),
    },
    async ({ draft_id }) => {
      await gmail.users.drafts.delete({ userId: "me", id: draft_id });
      return asText({ deleted: true, draftId: draft_id });
    }
  );

  server.tool("gmail_send_draft", "Gmail: send draft. / Gmail: отправить черновики.",
    {
      draft_id: z.string(),
    },
    async ({ draft_id }) => {
      const res = await gmail.users.drafts.send({ userId: "me", requestBody: { id: draft_id } });
      return asText(res.data);
    }
  );

  server.tool("gmail_get_label", "Gmail: get label. / Gmail: получить ярлыки.",
    {
      label_id: z.string(),
    },
    async ({ label_id }) => {
      const res = await gmail.users.labels.get({ userId: "me", id: label_id });
      return asText(res.data);
    }
  );

  server.tool("gmail_update_label", "Gmail: update label. / Gmail: обновить ярлыки.",
    {
      label_id: z.string(),
      label: z.record(z.any()).describe("Label resource"),
    },
    async ({ label_id, label }) => {
      const res = await gmail.users.labels.update({ userId: "me", id: label_id, requestBody: label });
      return asText(res.data);
    }
  );

  server.tool("gmail_patch_label", "Gmail: patch label. / Gmail: частично обновить ярлыки.",
    {
      label_id: z.string(),
      label: z.record(z.any()).describe("Label patch"),
    },
    async ({ label_id, label }) => {
      const res = await gmail.users.labels.patch({ userId: "me", id: label_id, requestBody: label });
      return asText(res.data);
    }
  );

  server.tool("gmail_delete_label", "Gmail: delete label. / Gmail: удалить ярлыки.",
    {
      label_id: z.string(),
    },
    async ({ label_id }) => {
      await gmail.users.labels.delete({ userId: "me", id: label_id });
      return asText({ deleted: true, labelId: label_id });
    }
  );

  server.tool("gmail_modify_thread", "Gmail: modify thread. / Gmail: изменить цепочки.",
    {
      thread_id: z.string(),
      add_label_ids: z.array(z.string()).optional(),
      remove_label_ids: z.array(z.string()).optional(),
    },
    async ({ thread_id, add_label_ids, remove_label_ids }) => {
      const res = await gmail.users.threads.modify({
        userId: "me",
        id: thread_id,
        requestBody: {
          addLabelIds: add_label_ids,
          removeLabelIds: remove_label_ids,
        },
      });
      return asText(res.data);
    }
  );

  server.tool("gmail_trash_thread", "Gmail: move to trash thread. / Gmail: переместить в корзину цепочки.",
    { thread_id: z.string() },
    async ({ thread_id }) => {
      const res = await gmail.users.threads.trash({ userId: "me", id: thread_id });
      return asText(res.data);
    }
  );

  server.tool("gmail_untrash_thread", "Gmail: restore from trash thread. / Gmail: восстановить из корзины цепочки.",
    { thread_id: z.string() },
    async ({ thread_id }) => {
      const res = await gmail.users.threads.untrash({ userId: "me", id: thread_id });
      return asText(res.data);
    }
  );

  server.tool("gmail_delete_thread_permanently", "Gmail: delete thread permanently. / Gmail: удалить цепочки permanently.",
    { thread_id: z.string() },
    async ({ thread_id }) => {
      await gmail.users.threads.delete({ userId: "me", id: thread_id });
      return asText({ deleted: true, threadId: thread_id });
    }
  );

  server.tool("gmail_get_auto_forwarding", "Gmail: get auto forwarding. / Gmail: получить auto forwarding.",
    {},
    async () => {
      const res = await gmailAny.users.settings.getAutoForwarding({ userId: "me" });
      return asText(res.data);
    }
  );

  server.tool("gmail_update_auto_forwarding", "Gmail: update auto forwarding. / Gmail: обновить auto forwarding.",
    {
      auto_forwarding: z.record(z.any()).describe("AutoForwarding settings"),
    },
    async ({ auto_forwarding }) => {
      const res = await gmailAny.users.settings.updateAutoForwarding({ userId: "me", requestBody: auto_forwarding });
      return asText(res.data);
    }
  );

  server.tool("gmail_get_imap", "Gmail: get imap. / Gmail: получить imap.",
    {},
    async () => {
      const res = await gmailAny.users.settings.getImap({ userId: "me" });
      return asText(res.data);
    }
  );

  server.tool("gmail_update_imap", "Gmail: update imap. / Gmail: обновить imap.",
    { imap: z.record(z.any()) },
    async ({ imap }) => {
      const res = await gmailAny.users.settings.updateImap({ userId: "me", requestBody: imap });
      return asText(res.data);
    }
  );

  server.tool("gmail_get_pop", "Gmail: get pop. / Gmail: получить pop.",
    {},
    async () => {
      const res = await gmailAny.users.settings.getPop({ userId: "me" });
      return asText(res.data);
    }
  );

  server.tool("gmail_update_pop", "Gmail: update pop. / Gmail: обновить pop.",
    { pop: z.record(z.any()) },
    async ({ pop }) => {
      const res = await gmailAny.users.settings.updatePop({ userId: "me", requestBody: pop });
      return asText(res.data);
    }
  );

  server.tool("gmail_get_vacation", "Gmail: get vacation. / Gmail: получить vacation.",
    {},
    async () => {
      const res = await gmailAny.users.settings.getVacation({ userId: "me" });
      return asText(res.data);
    }
  );

  server.tool("gmail_update_vacation", "Gmail: update vacation. / Gmail: обновить vacation.",
    { vacation: z.record(z.any()) },
    async ({ vacation }) => {
      const res = await gmailAny.users.settings.updateVacation({ userId: "me", requestBody: vacation });
      return asText(res.data);
    }
  );

  server.tool("gmail_get_language", "Gmail: get language. / Gmail: получить language.",
    {},
    async () => {
      const res = await gmailAny.users.settings.getLanguage({ userId: "me" });
      return asText(res.data);
    }
  );

  server.tool("gmail_update_language", "Gmail: update language. / Gmail: обновить language.",
    { language: z.record(z.any()) },
    async ({ language }) => {
      const res = await gmailAny.users.settings.updateLanguage({ userId: "me", requestBody: language });
      return asText(res.data);
    }
  );

  server.tool("gmail_list_filters", "Gmail: list filters. / Gmail: получить список filters.",
    {},
    async () => {
      const res = await gmailAny.users.settings.filters.list({ userId: "me" });
      return asText(res.data);
    }
  );

  server.tool("gmail_get_filter", "Gmail: get filter. / Gmail: получить filter.",
    { filter_id: z.string() },
    async ({ filter_id }) => {
      const res = await gmailAny.users.settings.filters.get({ userId: "me", id: filter_id });
      return asText(res.data);
    }
  );

  server.tool("gmail_create_filter", "Gmail: create filter. / Gmail: создать filter.",
    { filter: z.record(z.any()).describe("Filter resource") },
    async ({ filter }) => {
      const res = await gmailAny.users.settings.filters.create({ userId: "me", requestBody: filter });
      return asText(res.data);
    }
  );

  server.tool("gmail_delete_filter", "Gmail: delete filter. / Gmail: удалить filter.",
    { filter_id: z.string() },
    async ({ filter_id }) => {
      await gmailAny.users.settings.filters.delete({ userId: "me", id: filter_id });
      return asText({ deleted: true, filterId: filter_id });
    }
  );

  server.tool("gmail_list_forwarding_addresses", "Gmail: list forwarding addresses. / Gmail: получить список forwarding addresses.",
    {},
    async () => {
      const res = await gmailAny.users.settings.forwardingAddresses.list({ userId: "me" });
      return asText(res.data);
    }
  );

  server.tool("gmail_get_forwarding_address", "Gmail: get forwarding address. / Gmail: получить forwarding address.",
    { forwarding_email: z.string() },
    async ({ forwarding_email }) => {
      const res = await gmailAny.users.settings.forwardingAddresses.get({ userId: "me", forwardingEmail: forwarding_email });
      return asText(res.data);
    }
  );

  server.tool("gmail_create_forwarding_address", "Gmail: create forwarding address. / Gmail: создать forwarding address.",
    { forwarding_email: z.string() },
    async ({ forwarding_email }) => {
      const res = await gmailAny.users.settings.forwardingAddresses.create({
        userId: "me",
        requestBody: { forwardingEmail: forwarding_email },
      });
      return asText(res.data);
    }
  );

  server.tool("gmail_delete_forwarding_address", "Gmail: delete forwarding address. / Gmail: удалить forwarding address.",
    { forwarding_email: z.string() },
    async ({ forwarding_email }) => {
      await gmailAny.users.settings.forwardingAddresses.delete({ userId: "me", forwardingEmail: forwarding_email });
      return asText({ deleted: true, forwardingEmail: forwarding_email });
    }
  );

  server.tool("gmail_list_send_as", "Gmail: list send as. / Gmail: получить список send as.",
    {},
    async () => {
      const res = await gmailAny.users.settings.sendAs.list({ userId: "me" });
      return asText(res.data);
    }
  );

  server.tool("gmail_get_send_as", "Gmail: get send as. / Gmail: получить send as.",
    { send_as_email: z.string() },
    async ({ send_as_email }) => {
      const res = await gmailAny.users.settings.sendAs.get({ userId: "me", sendAsEmail: send_as_email });
      return asText(res.data);
    }
  );

  server.tool("gmail_create_send_as", "Gmail: create send as. / Gmail: создать send as.",
    { send_as: z.record(z.any()).describe("SendAs resource") },
    async ({ send_as }) => {
      const res = await gmailAny.users.settings.sendAs.create({ userId: "me", requestBody: send_as });
      return asText(res.data);
    }
  );

  server.tool("gmail_update_send_as", "Gmail: update send as. / Gmail: обновить send as.",
    {
      send_as_email: z.string(),
      send_as: z.record(z.any()),
    },
    async ({ send_as_email, send_as }) => {
      const res = await gmailAny.users.settings.sendAs.update({ userId: "me", sendAsEmail: send_as_email, requestBody: send_as });
      return asText(res.data);
    }
  );

  server.tool("gmail_patch_send_as", "Gmail: patch send as. / Gmail: частично обновить send as.",
    {
      send_as_email: z.string(),
      send_as: z.record(z.any()),
    },
    async ({ send_as_email, send_as }) => {
      const res = await gmailAny.users.settings.sendAs.patch({ userId: "me", sendAsEmail: send_as_email, requestBody: send_as });
      return asText(res.data);
    }
  );

  server.tool("gmail_delete_send_as", "Gmail: delete send as. / Gmail: удалить send as.",
    { send_as_email: z.string() },
    async ({ send_as_email }) => {
      await gmailAny.users.settings.sendAs.delete({ userId: "me", sendAsEmail: send_as_email });
      return asText({ deleted: true, sendAsEmail: send_as_email });
    }
  );

  server.tool("gmail_verify_send_as", "Gmail: verify send as. / Gmail: подтвердить send as.",
    { send_as_email: z.string() },
    async ({ send_as_email }) => {
      await gmailAny.users.settings.sendAs.verify({ userId: "me", sendAsEmail: send_as_email });
      return asText({ verificationSent: true, sendAsEmail: send_as_email });
    }
  );

  server.tool("gmail_list_delegates", "Gmail: list delegates. / Gmail: получить список delegates.",
    {},
    async () => {
      const res = await gmailAny.users.settings.delegates.list({ userId: "me" });
      return asText(res.data);
    }
  );

  server.tool("gmail_get_delegate", "Gmail: get delegate. / Gmail: получить delegate.",
    { delegate_email: z.string() },
    async ({ delegate_email }) => {
      const res = await gmailAny.users.settings.delegates.get({ userId: "me", delegateEmail: delegate_email });
      return asText(res.data);
    }
  );

  server.tool("gmail_create_delegate", "Gmail: create delegate. / Gmail: создать delegate.",
    { delegate_email: z.string() },
    async ({ delegate_email }) => {
      const res = await gmailAny.users.settings.delegates.create({
        userId: "me",
        requestBody: { delegateEmail: delegate_email },
      });
      return asText(res.data);
    }
  );

  server.tool("gmail_delete_delegate", "Gmail: delete delegate. / Gmail: удалить delegate.",
    { delegate_email: z.string() },
    async ({ delegate_email }) => {
      await gmailAny.users.settings.delegates.delete({ userId: "me", delegateEmail: delegate_email });
      return asText({ deleted: true, delegateEmail: delegate_email });
    }
  );

  server.tool("gmail_send_email", "Gmail: send email. / Gmail: отправить email.",
    {
      to: z.string().describe("Input parameter. / Входной параметр."),
      subject: z.string().describe("Input parameter. / Входной параметр."),
      body: z.string().describe("Input parameter. / Входной параметр."),
      cc: z.string().optional().describe("Input parameter. / Входной параметр."),
      bcc: z.string().optional().describe("Input parameter. / Входной параметр."),
    },
    async ({ to, subject, body, cc, bcc }) => {
      const mime = [
        `To: ${to}`,
        cc ? `Cc: ${cc}` : undefined,
        bcc ? `Bcc: ${bcc}` : undefined,
        "Content-Type: text/plain; charset=utf-8",
        "MIME-Version: 1.0",
        `Subject: ${subject}`,
        "",
        body,
      ].filter(Boolean).join("\r\n");
      const raw = Buffer.from(mime).toString("base64url");
      const res = await gmail.users.messages.send({
        userId: "me",
        requestBody: { raw },
      });
      return asText(res.data);
    }
  );

  server.tool("gmail_send_email_with_attachments", "Gmail: send email with attachments. / Gmail: отправить email with вложения.",
    {
      to: z.string().describe("Input parameter. / Входной параметр."),
      subject: z.string().describe("Input parameter. / Входной параметр."),
      body: z.string().describe("Input parameter. / Входной параметр."),
      cc: z.string().optional().describe("Input parameter. / Входной параметр."),
      bcc: z.string().optional().describe("Input parameter. / Входной параметр."),
      attachments: z.array(z.object({
        filename: z.string(),
        mime_type: z.string().optional(),
        content_base64: z.string(),
      })).min(1),
    },
    async ({ to, subject, body, cc, bcc, attachments }) => {
      const raw = encodeBase64Url(buildMimeMessage({ to, subject, body, cc, bcc, attachments }));
      const res = await gmail.users.messages.send({
        userId: "me",
        requestBody: { raw },
      });
      return asText(res.data);
    }
  );

  server.tool("workspace_gmail_list_messages", "Google Workspace: gmail list messages. / Google Workspace: gmail list письма.",
    {
      query: z.string().optional(),
      max_results: z.number().int().min(1).max(100).optional().default(20),
      page_token: z.string().optional(),
      label_ids: z.array(z.string()).optional(),
    },
    async ({ query, max_results, page_token, label_ids }) => {
      const res = await gmail.users.messages.list({
        userId: "me",
        q: query,
        maxResults: max_results,
        pageToken: page_token,
        labelIds: label_ids,
      });
      return asText({
        messages: res.data.messages ?? [],
        nextPageToken: res.data.nextPageToken,
        resultSizeEstimate: res.data.resultSizeEstimate,
      });
    }
  );

  server.tool("people_list_contacts", "people_list_contacts. / people_list_contacts.",
    {
      page_size: z.number().int().min(1).max(1000).optional().default(100),
      page_token: z.string().optional(),
    },
    async ({ page_size, page_token }) => {
      const res = await people.people.connections.list({
        resourceName: "people/me",
        pageSize: page_size,
        pageToken: page_token,
        personFields: "names,emailAddresses,phoneNumbers,organizations",
      });
      return asText({
        connections: res.data.connections ?? [],
        nextPageToken: res.data.nextPageToken,
        totalItems: res.data.totalItems,
      });
    }
  );

  server.tool("people_search_contacts", "people_search_contacts. / people_search_contacts.",
    {
      query: z.string().describe("Input parameter. / Входной параметр."),
      page_size: z.number().int().min(1).max(30).optional().default(10),
    },
    async ({ query, page_size }) => {
      const res = await people.people.searchContacts({
        query,
        pageSize: page_size,
        readMask: "names,emailAddresses,phoneNumbers,organizations",
      });
      return asText(res.data.results ?? []);
    }
  );

  server.tool("people_get_person", "people_get_person. / people_get_person.",
    {
      resource_name: z.string().describe("Input parameter. / Входной параметр."),
    },
    async ({ resource_name }) => {
      const res = await people.people.get({
        resourceName: resource_name,
        personFields: "names,emailAddresses,phoneNumbers,organizations,addresses,biographies,birthdays,urls",
      });
      return asText(res.data);
    }
  );

  server.tool("workspace_people_list_contacts", "Google Workspace: people list contacts. / Google Workspace: people list contacts.",
    {
      page_size: z.number().int().min(1).max(1000).optional().default(100),
      page_token: z.string().optional(),
    },
    async ({ page_size, page_token }) => {
      const res = await people.people.connections.list({
        resourceName: "people/me",
        pageSize: page_size,
        pageToken: page_token,
        personFields: "names,emailAddresses,phoneNumbers,organizations",
      });
      return asText({
        connections: res.data.connections ?? [],
        nextPageToken: res.data.nextPageToken,
        totalItems: res.data.totalItems,
      });
    }
  );

  server.tool("forms_list_forms", "forms_list_forms. / forms_list_forms.",
    {
      query: z.string().optional().describe("Input parameter. / Входной параметр."),
      max_results: z.number().int().min(1).max(100).optional().default(20),
    },
    async ({ query, max_results }) => {
      let q = "trashed = false and mimeType = 'application/vnd.google-apps.form'";
      if (query) q += ` and ${query}`;
      const res = await drive.files.list({
        q,
        pageSize: max_results,
        orderBy: "modifiedTime desc",
        fields: "files(id, name, mimeType, modifiedTime, webViewLink)",
      });
      return asText(res.data.files ?? []);
    }
  );

  server.tool("forms_get_form", "forms_get_form. / forms_get_form.",
    {
      form_id: z.string().describe("Input parameter. / Входной параметр."),
    },
    async ({ form_id }) => {
      const res = await forms.forms.get({ formId: form_id });
      return asText(res.data);
    }
  );

  server.tool("forms_create_form", "forms_create_form. / forms_create_form.",
    {
      title: z.string().describe("Input parameter. / Входной параметр."),
      document_title: z.string().optional().describe("Input parameter. / Входной параметр."),
    },
    async ({ title, document_title }) => {
      const res = await forms.forms.create({
        requestBody: {
          info: {
            title,
            documentTitle: document_title ?? title,
          },
        },
      });
      return asText(res.data);
    }
  );

  server.tool("forms_update_form", "forms_update_form. / forms_update_form.",
    {
      form_id: z.string().describe("Input parameter. / Входной параметр."),
      requests: z.array(z.any()).min(1).describe("Input parameter. / Входной параметр."),
      include_form_in_response: z.boolean().optional().default(true),
    },
    async ({ form_id, requests, include_form_in_response }) => {
      const res = await forms.forms.batchUpdate({
        formId: form_id,
        requestBody: {
          requests,
          includeFormInResponse: include_form_in_response,
        },
      });
      return asText(res.data);
    }
  );

  server.tool("forms_list_responses", "forms_list_responses. / forms_list_responses.",
    {
      form_id: z.string().describe("Input parameter. / Входной параметр."),
      max_results: z.number().int().min(1).max(500).optional().default(50),
    },
    async ({ form_id, max_results }) => {
      const res = await forms.forms.responses.list({
        formId: form_id,
        pageSize: max_results,
      });
      return asText(res.data.responses ?? []);
    }
  );

  server.tool("workspace_forms_list_forms", "Google Workspace: forms list forms. / Google Workspace: forms list forms.",
    {
      query: z.string().optional(),
      max_results: z.number().int().min(1).max(100).optional().default(20),
    },
    async ({ query, max_results }) => {
      let q = "trashed = false and mimeType = 'application/vnd.google-apps.form'";
      if (query) q += ` and ${query}`;
      const res = await drive.files.list({
        q,
        pageSize: max_results,
        orderBy: "modifiedTime desc",
        fields: "files(id, name, mimeType, modifiedTime, webViewLink)",
      });
      return asText(res.data.files ?? []);
    }
  );

  return server;
}

// ─── Express app ─────────────────────────────────────────────────────────────
const app = express();
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && (origin === "https://claude.ai" || origin === "https://claude.com")) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, mcp-session-id, mcp-protocol-version");
  res.setHeader("Access-Control-Expose-Headers", "mcp-session-id, mcp-protocol-version, WWW-Authenticate");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
});
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// OAuth metadata for MCP clients (Claude Connectors / Inspector / SDK clients)
app.use(mcpAuthMetadataRouter({
  oauthMetadata: GOOGLE_OAUTH_METADATA,
  resourceServerUrl: PUBLIC_MCP_URL,
  scopesSupported: SCOPES,
  resourceName: "Google Workspace MCP",
  serviceDocumentationUrl: new URL(`${PUBLIC_ORIGIN}${PUBLIC_PREFIX || ""}/health`),
}));

// OAuth proxy endpoints for Claude Connectors
app.post("/oauth/register", (req, res) => {
  res.status(201).json({
    client_id: `claude-${randomId().slice(0, 16)}`,
    client_secret_expires_at: 0,
    redirect_uris: req.body?.redirect_uris || [],
    grant_types: ["authorization_code"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  });
});

app.get("/oauth/authorize", (req, res) => {
  const redirectUri = String(req.query.redirect_uri || "");
  const state = String(req.query.state || "");
  const codeChallenge = req.query.code_challenge ? String(req.query.code_challenge) : undefined;
  const codeChallengeMethod = req.query.code_challenge_method ? String(req.query.code_challenge_method) : undefined;

  if (!redirectUri) {
    res.status(400).send("Missing redirect_uri");
    return;
  }

  const auth = createOAuthClient();
  const googleState = encodeState({ redirectUri, state, codeChallenge, codeChallengeMethod });
  const url = auth.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    prompt: "consent",
    state: googleState,
  });
  res.redirect(url);
});

app.get("/oauth/start", (req, res) => {
  const auth = createOAuthClient();
  const url = auth.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    prompt: "consent",
  });
  res.json({
    message: "Open this URL to authorize Google manually",
    auth_url: url,
    connector_hint: {
      resource_metadata: RESOURCE_METADATA_URL,
      authorization_server: AUTH_ISSUER,
    },
  });
});

app.get("/oauth/callback", async (req, res) => {
  const googleCode = req.query.code as string;
  const rawState = req.query.state as string;
  if (!googleCode || !rawState) {
    res.status(400).json({ error: "Missing authorization code or state" });
    return;
  }

  try {
    const connectorState = decodeState(rawState) as {
      redirectUri: string;
      state?: string;
      codeChallenge?: string;
      codeChallengeMethod?: string;
    };
    const auth = createOAuthClient();
    const { tokens } = await auth.getToken(googleCode);

    const connectorCode = randomId();
    codeStore.set(connectorCode, {
      tokens,
      redirectUri: connectorState.redirectUri,
      scope: SCOPES.join(" "),
      codeChallenge: connectorState.codeChallenge,
      codeChallengeMethod: connectorState.codeChallengeMethod,
    });

    const redirect = new URL(connectorState.redirectUri);
    redirect.searchParams.set("code", connectorCode);
    if (connectorState.state) redirect.searchParams.set("state", connectorState.state);
    res.redirect(redirect.toString());
  } catch (err) {
    res.status(500).json({ error: "Token exchange failed", details: String(err) });
  }
});

app.post("/oauth/token", (req, res) => {
  const grantType = String(req.body?.grant_type || "authorization_code");

  if (grantType === "authorization_code") {
    const code = String(req.body?.code || "");
    const entry = codeStore.get(code);
    if (!entry) {
      res.status(400).json({ error: "invalid_grant" });
      return;
    }
    codeStore.delete(code);

    const accessToken = randomId();
    const connectorRefreshToken = randomId();
    const now = Date.now();
    const tokenEntry: ConnectorTokenEntry = {
      tokens: entry.tokens,
      scope: entry.scope,
      connectorRefreshToken,
      createdAt: now,
      updatedAt: now,
    };
    tokenStore.set(accessToken, tokenEntry);
    refreshTokenStore.set(connectorRefreshToken, accessToken);
    savePersistedTokens();

    res.json({
      access_token: accessToken,
      refresh_token: connectorRefreshToken,
      token_type: "Bearer",
      expires_in: 3600,
      scope: entry.scope,
    });
    return;
  }

  if (grantType === "refresh_token") {
    const refreshToken = String(req.body?.refresh_token || "");
    const previousAccessToken = refreshTokenStore.get(refreshToken);
    const previousEntry = previousAccessToken ? tokenStore.get(previousAccessToken) : undefined;
    if (!previousAccessToken || !previousEntry) {
      res.status(400).json({ error: "invalid_grant" });
      return;
    }

    const accessToken = randomId();
    const tokenEntry: ConnectorTokenEntry = {
      ...previousEntry,
      updatedAt: Date.now(),
    };
    tokenStore.delete(previousAccessToken);
    tokenStore.set(accessToken, tokenEntry);
    refreshTokenStore.set(refreshToken, accessToken);
    savePersistedTokens();

    res.json({
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: "Bearer",
      expires_in: 3600,
      scope: tokenEntry.scope,
    });
    return;
  }

  res.status(400).json({ error: "unsupported_grant_type" });
});

app.post("/oauth/revoke", (req, res) => {
  const token = String(req.body?.token || "");
  if (token) {
    const tokenEntry = tokenStore.get(token);
    tokenStore.delete(token);
    if (tokenEntry?.connectorRefreshToken) {
      refreshTokenStore.delete(tokenEntry.connectorRefreshToken);
    } else if (refreshTokenStore.has(token)) {
      const accessToken = refreshTokenStore.get(token);
      refreshTokenStore.delete(token);
      if (accessToken) tokenStore.delete(accessToken);
    }
    savePersistedTokens();
  }
  res.status(200).json({ ok: true });
});

app.get("/health", (_, res) => {
  res.json({
    status: "ok",
    service: "google-workspace-mcp",
    version: "1.8.0",
    authMode: "google-oauth-protected-resource",
    publicMcpUrl: PUBLIC_MCP_URL.href,
    resourceMetadataUrl: RESOURCE_METADATA_URL,
    features: ["drive", "docs", "sheets", "slides", "calendar", "tasks", "gmail", "people", "forms"],
  });
});

const bearerAuth = requireBearerAuth({
  verifier: { verifyAccessToken: verifyGoogleAccessToken },
  requiredScopes: SCOPES,
  resourceMetadataUrl: RESOURCE_METADATA_URL,
});

app.all("/mcp", bearerAuth, async (req, res) => {
  const accessToken = getAccessTokenFromRequest(req);
  if (!accessToken) {
    // Should already be handled by bearerAuth, but keep a defensive guard.
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const auth = createOAuthClient();
    const storedTokens = tokenStore.get(accessToken);
    if (!storedTokens) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    auth.setCredentials(storedTokens.tokens);

    const server = createDriveMcpServer(auth);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    res.on("close", () => transport.close());
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP error:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error" });
    }
  }
});

app.listen(PORT, HOST, () => {
  console.log(`🚀 Google Workspace MCP running on http://${HOST}:${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/health`);
  console.log(`   Public MCP URL: ${PUBLIC_MCP_URL.href}`);
  console.log(`   Resource metadata: ${RESOURCE_METADATA_URL}`);
});
