// @ts-nocheck
// AUTO-GENERATED Edge Function: notion-payslips
// Reproduces the desktop app's notion:query-teacher-payslips handler server-side,
// keeping NOTION_TOKEN off the client. Built from main.js + notion-simplify.js.
const NOTION_VERSION = "2026-03-11";
const NOTION_QUERY_PAGE_SIZE = 100;
const NOTION_QUERY_MAX_ROWS = 10000;
function loadDotenv() { /* no-op in edge runtime; env via supabase secrets */ }
function notionMissingTokenMessage() {
  return "Missing NOTION_TOKEN on the server. Set it with: supabase secrets set NOTION_TOKEN=...";
}

/**
 * Turn Notion property payloads into plain strings for table cells.
 * @param {{ type: string }} prop
 */

const SHORT_MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/**
 * @param {number} y full year
 * @param {number} month1to12
 * @param {number} day
 * @returns {string} e.g. Mar 31 / 2006
 */
function formatYmdPartsAsMarDdYy(y, month1to12, day) {
  const d = new Date(y, month1to12 - 1, day);
  if (Number.isNaN(d.getTime())) {
    return "";
  }
  const mo = SHORT_MONTH_NAMES[d.getMonth()];
  return `${mo} ${d.getDate()} / ${d.getFullYear()}`;
}

/**
 * @param {string | undefined | null} isoLike Notion date start/end or ISO datetime
 * @returns {string} e.g. Mar 31 / 2006
 */
function formatNotionDateForDisplay(isoLike) {
  if (isoLike == null || isoLike === "") {
    return "";
  }
  const s = String(isoLike).trim();

  const plain = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (plain) {
    const out = formatYmdPartsAsMarDdYy(
      Number(plain[1]),
      Number(plain[2]),
      Number(plain[3]),
    );
    return out || s;
  }

  /** Notion often encodes date-only as midnight UTC. */
  if (
    /^(\d{4})-(\d{2})-(\d{2})T00:00:00(?:\.0+)?Z$/.test(s) ||
    /^(\d{4})-(\d{2})-(\d{2})T00:00:00(?:\.0+)?[+-]00:?00$/.test(s)
  ) {
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) {
      const out = formatYmdPartsAsMarDdYy(
        Number(m[1]),
        Number(m[2]),
        Number(m[3]),
      );
      return out || s;
    }
  }

  const d = new Date(s);
  if (Number.isNaN(d.getTime())) {
    return s;
  }
  return (
    formatYmdPartsAsMarDdYy(
      d.getFullYear(),
      d.getMonth() + 1,
      d.getDate(),
    ) || s
  );
}

function propertyToString(prop) {
  if (!prop) {
    return "";
  }
  switch (prop.type) {
    case "title":
      return richTextToPlain(prop.title);
    case "rich_text":
      return richTextToPlain(prop.rich_text);
    case "number":
      return prop.number == null ? "" : String(prop.number);
    case "select":
      return prop.select?.name ?? "";
    case "multi_select":
      return (prop.multi_select ?? []).map((s) => s.name).join(", ");
    case "date": {
      if (!prop.date) {
        return "";
      }
      const { start, end } = prop.date;
      if (!start) {
        return "";
      }
      const startFmt = formatNotionDateForDisplay(start);
      if (end) {
        return `${startFmt} → ${formatNotionDateForDisplay(end)}`;
      }
      return startFmt;
    }
    case "people":
      return (prop.people ?? [])
        .map((p) => p.name || p.id)
        .filter(Boolean)
        .join(", ");
    case "files":
      return (prop.files ?? []).map((f) => f.name || "(file)").join(", ");
    case "checkbox":
      return prop.checkbox ? "Yes" : "No";
    case "url":
      return prop.url ?? "";
    case "email":
      return prop.email ?? "";
    case "phone_number":
      return prop.phone_number ?? "";
    case "status":
      return prop.status?.name ?? "";
    case "created_time":
      return formatNotionDateForDisplay(prop.created_time ?? "");
    case "last_edited_time":
      return formatNotionDateForDisplay(prop.last_edited_time ?? "");
    case "created_by":
      return prop.created_by?.name ?? prop.created_by?.id ?? "";
    case "last_edited_by":
      return prop.last_edited_by?.name ?? prop.last_edited_by?.id ?? "";
    case "formula":
      return formulaToString(prop.formula);
    case "relation":
      return (prop.relation ?? [])
        .map((r) => {
          if (r && typeof r === "object") {
            // Populated server-side via enrichRelationTitlesOnPages (linked DB title).
            const named =
              typeof r.display_name === "string"
                ? r.display_name.trim()
                : "";
            if (named) {
              return named;
            }
            if (typeof r.id === "string" && r.id.trim()) {
              return r.id.trim();
            }
          }
          return "";
        })
        .filter(Boolean)
        .join(", ");
    case "rollup":
      return rollupToString(prop.rollup);
    case "unique_id":
      if (!prop.unique_id) {
        return "";
      }
      const p = prop.unique_id.prefix;
      const n = prop.unique_id.number;
      return p ? `${p}-${n}` : String(n);
    default:
      return "";
  }
}

function richTextToPlain(chunks) {
  if (!chunks || !chunks.length) {
    return "";
  }
  return chunks.map((c) => c.plain_text || "").join("");
}

function formulaToString(formula) {
  if (!formula) {
    return "";
  }
  switch (formula.type) {
    case "string":
      return formula.string ?? "";
    case "number":
      return formula.number == null ? "" : String(formula.number);
    case "boolean":
      return formula.boolean ? "Yes" : "No";
    case "date":
      return formatNotionDateForDisplay(formula.date?.start ?? "");
    default:
      return "";
  }
}

function rollupToString(rollup) {
  if (!rollup) {
    return "";
  }
  switch (rollup.type) {
    case "number":
      return rollup.number == null ? "" : String(rollup.number);
    case "date":
      return formatNotionDateForDisplay(rollup.date?.start ?? "");
    case "array": {
      const items = rollup.array ?? [];
      return items
        .map((item) => {
          if (item.type === "title") {
            return richTextToPlain(item.title);
          }
          if (item.type === "rich_text") {
            return richTextToPlain(item.rich_text);
          }
          if (item.type === "select") {
            return item.select?.name ?? "";
          }
          if (item.type === "multi_select") {
            return (item.multi_select ?? []).map((s) => s.name).join(", ");
          }
          return "";
        })
        .filter(Boolean)
        .join(", ");
    }
    default:
      return "";
  }
}

function normalizePageId(raw) {
  if (!raw) {
    return "";
  }
  const s = String(raw).trim();
  const hex = s.replace(/-/g, "");
  if (hex.length !== 32) {
    return s;
  }
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * @param {Array<{ id?: string; properties?: Record<string, unknown> }>} pages
 */
/**
 * Put the main column first: property named "Name" (any casing), else Notion `title` type.
 * @param {string[]} columns sorted names
 * @param {Record<string, { type?: string }> | null} sampleProps properties from any page
 */
function orderColumnsMainFirst(columns, sampleProps) {
  const nameIdx = columns.findIndex(
    (c) =>
      c.trim().localeCompare("name", undefined, { sensitivity: "base" }) === 0,
  );
  let leadIdx = nameIdx;
  if (leadIdx < 0 && sampleProps) {
    leadIdx = columns.findIndex((col) => sampleProps[col]?.type === "title");
  }
  if (leadIdx > 0) {
    const [lead] = columns.splice(leadIdx, 1);
    columns.unshift(lead);
  }
  return columns;
}

/**
 * Property names shown right after the title column on the admin sheet (aligned with pay slip email matching in main.js).
 * @param {string} col
 * @returns {boolean}
 */
function isEmailLikeColumnName(col) {
  const s = String(col).trim();
  if (!s) {
    return false;
  }
  if (/^e-?mails?$/i.test(s)) {
    return true;
  }
  if (/\b(e-?mails?|email\s+address)\b/i.test(s)) {
    return true;
  }
  if (/\be\s*mail\b/i.test(s)) {
    return true;
  }
  if (/\bemail\b/i.test(s)) {
    return true;
  }
  if (/\b(e-?mail|electronic\s+mail)\b/i.test(s)) {
    return true;
  }
  return (
    /\b(teacher|contact|work|staff|payee|pay\s*roll|payroll)\b/i.test(s) &&
    /\b(e-?mail|email)\b/i.test(s)
  );
}

/**
 * After Name / title, place email-related columns so new Notion email fields are visible without scrolling.
 * @param {string[]} columns
 * @returns {string[]}
 */
function orderEmailColumnsAfterLead(columns) {
  if (columns.length <= 1) {
    return columns;
  }
  const lead = columns[0];
  const rest = columns.slice(1);
  const emailCols = [];
  const other = [];
  for (const c of rest) {
    if (isEmailLikeColumnName(c)) {
      emailCols.push(c);
    } else {
      other.push(c);
    }
  }
  emailCols.sort((a, b) => a.localeCompare(b));
  return [lead, ...emailCols, ...other];
}

/** Normalized (`trim`, lower-case, collapsed spaces). */
function normalizedNotionSheetColumnLabel(col) {
  return String(col ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

/** Omitted entirely from exported tables (still exists in Notion). */
const OMITTED_NOTION_SHEET_COLUMN_LABELS_NORMALIZED = new Set([
  "adults classes",
]);

function omitNotionSheetColumnByLabel(col) {
  return OMITTED_NOTION_SHEET_COLUMN_LABELS_NORMALIZED.has(
    normalizedNotionSheetColumnLabel(col),
  );
}

/**
 * Visible column title in sheets and PDF. Notion updates still use the raw property name.
 * @param {string | undefined | null} col
 * @returns {string}
 */
function displayNotionSheetColumnLabel(col) {
  const n = normalizedNotionSheetColumnLabel(col);
  if (n === "adults") {
    return "ADULTS CLASSES";
  }
  if (n === "kid" || n === "kids") {
    return "KIDS CLASSES";
  }
  if (n === "trial" || n === "trials") {
    return "TRIAL CLASSES";
  }
  return String(col ?? "");
}

function pagesToTable(pages) {
  /** @type {Set<string>} */
  const colSet = new Set();
  /** @type {Record<string, unknown> | null} */
  let sampleProps = null;
  for (const page of pages) {
    if ("properties" in page && page.properties) {
      Object.keys(page.properties).forEach((k) => colSet.add(k));
      if (!sampleProps && Object.keys(page.properties).length) {
        sampleProps = page.properties;
      }
    }
  }
  const columns = orderEmailColumnsAfterLead(
    orderColumnsMainFirst(
      Array.from(colSet).sort((a, b) => a.localeCompare(b)),
      sampleProps,
    ),
  ).filter((c) => !omitNotionSheetColumnByLabel(c));
  const rows = pages.map((page) => {
    const props = "properties" in page && page.properties ? page.properties : {};
    return columns.map((col) => propertyToString(props[col]));
  });
  const pageIds = pages.map((page) =>
    page && page.id ? normalizePageId(page.id) : "",
  );
  return { columns, rows, pageIds };
}


function normalizeNotionToken(raw) {
  if (!raw || typeof raw !== "string") {
    return "";
  }
  let t = raw.trim();
  if (
    (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith("'") && t.endsWith("'"))
  ) {
    t = t.slice(1, -1).trim();
  }
  const lower = t.toLowerCase();
  if (lower.startsWith("bearer ")) {
    t = t.slice(7).trim();
  }
  return t;
}

function normalizeDatabaseId(raw) {
  if (!raw) {
    return "";
  }
  const s = String(raw).trim();
  const hex = s.replace(/-/g, "");
  if (hex.length !== 32) {
    return s;
  }
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function normalizeDataSourceId(raw) {
  if (!raw) {
    return "";
  }
  let s = String(raw).trim();
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    s = s.slice(1, -1).trim();
  }
  if (s.toLowerCase().startsWith("collection://")) {
    s = s.slice("collection://".length).trim();
  }
  return normalizeDatabaseId(s);
}

function notionHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "Notion-Version": NOTION_VERSION,
  };
}

function notionReadHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    "Notion-Version": NOTION_VERSION,
  };
}

async function resolveDataSourceId(token, databaseId, explicitFallbackDs) {
  const res = await fetch(
    "https://" + "api.notion.com/v1/databases/" + databaseId,
    {
      method: "GET",
      headers: notionReadHeaders(token),
    },
  );
  const bodyText = await res.text();
  if (!res.ok) {
    const err = new Error(
      `Could not load database metadata (${res.status}): ${bodyText}. Check NOTION_DATABASE_ID and that the integration can access this database.`,
    );
    err.code = "API";
    throw err;
  }
  const data = JSON.parse(bodyText);
  const sources = data.data_sources;
  if (!Array.isArray(sources) || sources.length === 0) {
    const fromExplicit = normalizeDataSourceId(explicitFallbackDs);
    if (fromExplicit) {
      return fromExplicit;
    }
    const fromEnv = normalizeDataSourceId(Deno.env.get("NOTION_DATA_SOURCE_ID"));
    if (fromEnv) {
      return fromEnv;
    }
    const err = new Error(
      "This database has no data_sources in the API response. For wiki databases, set NOTION_DATA_SOURCE_ID in .env to the data source UUID (from the database URL or Notion devtools).",
    );
    err.code = "CONFIG";
    throw err;
  }
  return sources[0].id;
}

function isDataSourceQueryPageRow(r) {
  if (!r || typeof r !== "object") {
    return false;
  }
  const o = /** @type {any} */ (r);
  if (o.object === "data_source") {
    return false;
  }
  if (o.object === "page") {
    return true;
  }
  return (
    o.properties != null &&
    typeof o.properties === "object" &&
    !Array.isArray(o.properties)
  );
}

async function queryDataSourceAllPages(token, dataSourceId) {
  const allPages = [];
  /** @type {string | undefined} */
  let startCursor;
  let hasMore = true;
  let iterations = 0;

  while (hasMore && allPages.length < NOTION_QUERY_MAX_ROWS) {
    iterations += 1;
    if (iterations > 200) {
      break;
    }
    const body = {
      page_size: NOTION_QUERY_PAGE_SIZE,
      /** Wiki DBs can return child data_source rows; pay slip rows are always pages. */
      result_type: "page",
    };
    if (startCursor) {
      body.start_cursor = startCursor;
    }

    const res = await fetch(
      "https://" + "api.notion.com/v1/data_sources/" + dataSourceId + "/query",
      {
        method: "POST",
        headers: notionHeaders(token),
        body: JSON.stringify(body),
      },
    );

    const bodyText = await res.text();
    if (!res.ok) {
      let message = `Notion API ${res.status}: ${bodyText}`;
      if (res.status === 401) {
        message +=
          "\n\nFix checklist:\n" +
          "• Use an Internal integration: Notion integrations page → New integration → type Internal. Copy the full secret (one line, no spaces).\n" +
          "- The OAuth bot invite URL only needs client_id, scope, and permissions.\n" +
          "No secret of any kind is required for this URL — never include one.\n" +
          "• After pasting, save .env and restart the app. Try \"Refresh secret\" in Notion if this key was ever shared.";
      }
      const err = new Error(message);
      err.code = "API";
      throw err;
    }

    const data = JSON.parse(bodyText);
    const results = Array.isArray(data.results) ? data.results : [];
    for (const r of results) {
      if (isDataSourceQueryPageRow(r)) {
        allPages.push(r);
      }
    }

    hasMore = Boolean(data.has_more);
    startCursor =
      typeof data.next_cursor === "string" && data.next_cursor.trim()
        ? data.next_cursor.trim()
        : undefined;
    if (!hasMore || !startCursor) {
      break;
    }
  }

  return allPages;
}

async function resolveNotionTokenAndDataSourceId(opts = {}) {
  const token = normalizeNotionToken(Deno.env.get("NOTION_TOKEN"));
  const optDb = normalizeDatabaseId(opts.databaseId);
  const optDs = normalizeDataSourceId(opts.dataSourceId);
  const envDb = normalizeDatabaseId(Deno.env.get("NOTION_DATABASE_ID"));
  const envDs = normalizeDataSourceId(Deno.env.get("NOTION_DATA_SOURCE_ID"));

  if (!token) {
    const err = new Error(notionMissingTokenMessage());
    err.code = "CONFIG";
    throw err;
  }

  /** @type {string} */
  let dataSourceId = "";

  if (optDb) {
    dataSourceId = await resolveDataSourceId(token, optDb, optDs);
  } else if (optDs) {
    dataSourceId = optDs;
  } else if (envDb) {
    dataSourceId = await resolveDataSourceId(token, envDb, envDs);
  } else if (envDs) {
    dataSourceId = envDs;
  } else {
    const err = new Error(
      "Set NOTION_DATABASE_ID (database page URL id) and/or NOTION_DATA_SOURCE_ID. The app uses API 2026-03-11: it queries POST /v1/data_sources/{id}/query (legacy /databases/.../query is not valid on this version).",
    );
    err.code = "CONFIG";
    throw err;
  }

  return { token, dataSourceId };
}

function plainTitleFromNotionPageProperties(properties) {
  if (!properties || typeof properties !== "object") {
    return "";
  }
  for (const key of Object.keys(properties)) {
    const p = /** @type {any} */ (
      properties[key]
    );
    if (p && p.type === "title" && Array.isArray(p.title)) {
      return p.title.map((t) => t.plain_text || "").join("").trim();
    }
  }
  return "";
}

async function enrichRelationTitlesOnPages(token, pages) {
  if (!pages.length) {
    return;
  }

  /** @type {Set<string>} */
  const ids = new Set();

  for (const page of pages) {
    if (!page || typeof page !== "object") {
      continue;
    }
    const props = /** @type {any} */ (page).properties;
    if (!props || typeof props !== "object") {
      continue;
    }
    for (const raw of Object.values(props)) {
      const prop =
        /** @type {any} */ (
          raw
        );
      if (!prop || prop.type !== "relation" || !Array.isArray(prop.relation)) {
        continue;
      }
      for (const r of prop.relation) {
        if (r && typeof r.id === "string") {
          const id = normalizePageId(r.id.trim());
          if (id) {
            ids.add(id);
          }
        }
      }
    }
  }

  if (!ids.size) {
    return;
  }

  const list = [...ids];
  /** @type {Map<string, string>} */
  const idToTitle = new Map();

  const CHUNK = 6;
  for (let i = 0; i < list.length; i += CHUNK) {
    const chunk = list.slice(i, i + CHUNK);
    await Promise.all(
      chunk.map(async (id) => {
        try {
          const res = await fetch("https://" + "api.notion.com/v1/pages/" + id, {
            method: "GET",
            headers: notionReadHeaders(token),
          });
          const text = await res.text();
          if (!res.ok) {
            return;
          }
          const data = /** @type {any} */ (JSON.parse(text));
          const title = plainTitleFromNotionPageProperties(data.properties);
          if (title) {
            idToTitle.set(id, title);
          }
        } catch {
          /* ignore */
        }
      }),
    );
    if (i + CHUNK < list.length) {
      await new Promise((r) => setTimeout(r, 40));
    }
  }

  for (const page of pages) {
    if (!page || typeof page !== "object") {
      continue;
    }
    const props = /** @type {any} */ (page).properties;
    if (!props || typeof props !== "object") {
      continue;
    }
    for (const raw of Object.values(props)) {
      const prop =
        /** @type {any} */ (
          raw
        );
      if (!prop || prop.type !== "relation" || !Array.isArray(prop.relation)) {
        continue;
      }
      prop.relation = prop.relation.map((r) => {
        if (!r || typeof r !== "object" || typeof r.id !== "string") {
          return r;
        }
        const nid = normalizePageId(r.id.trim());
        const name = idToTitle.get(nid);
        if (typeof name === "string" && name.trim()) {
          return {
            ...r,
            display_name: name.trim(),
          };
        }
        return r;
      });
    }
  }
}

async function queryNotionTableForSource(opts = {}) {
  const { token, dataSourceId } = await resolveNotionTokenAndDataSourceId(opts);
  const pages = await queryDataSourceAllPages(token, dataSourceId);
  await enrichRelationTitlesOnPages(token, pages);
  return pagesToTable(pages);
}

async function queryNotionTeacherPayslipRowsPartialEnrich(
  sourceOpts,
  email,
  notionPersonRecordId,
  mode,
) {
  const { token, dataSourceId } =
    await resolveNotionTokenAndDataSourceId(sourceOpts);
  const pages = await queryDataSourceAllPages(token, dataSourceId);
  const baseTable = pagesToTable(pages);

  /** @type {{ columns: string[]; rows: string[][]; pageIds: string[]; noEmailColumn?: boolean }} */
  let filtered;

  if (mode?.personOnly && notionPersonRecordId) {
    filtered = filterPayslipsForNotionPerson(baseTable, notionPersonRecordId);
  } else if (notionPersonRecordId) {
    const byPerson = filterPayslipsForNotionPerson(
      baseTable,
      notionPersonRecordId,
    );
    filtered =
      byPerson.rows.length > 0
        ? byPerson
        : filterPayslipsForTeacher(baseTable, email);
  } else {
    filtered = filterPayslipsForTeacher(baseTable, email);
  }

  /** @type {Map<string, object>} */
  const pageById = new Map();
  for (const p of pages) {
    if (!p || typeof p !== "object" || !("id" in p)) {
      continue;
    }
    const id = normalizePageId(String(/** @type {{ id?: unknown }} */ (p).id));
    if (id) {
      pageById.set(id, /** @type {object} */ (p));
    }
  }

  const orderedSubset = [];
  for (const rawPid of filtered.pageIds || []) {
    const pid = normalizePageId(String(rawPid));
    const pg = pid ? pageById.get(pid) : undefined;
    if (pg) {
      orderedSubset.push(pg);
    }
  }

  await enrichRelationTitlesOnPages(token, orderedSubset);
  const out = pagesToTable(orderedSubset);
  return {
    ok: true,
    columns: out.columns,
    rows: out.rows,
    pageIds: out.pageIds,
    noEmailColumn: Boolean(filtered.noEmailColumn),
  };
}

function normalizeEmailForPayslip(s) {
  let e = String(s || "")
    .trim()
    .toLowerCase()
    .replace(/^mailto:/i, "");
  if (e.endsWith("@googlemail.com")) {
    const local = e.slice(0, -"@googlemail.com".length);
    e = `${local}@gmail.com`;
  }
  return e;
}

function extractEmailsFromCell(raw) {
  const s = String(raw ?? "");
  const set = new Set();
  const add = (v) => {
    const n = normalizeEmailForPayslip(v);
    if (n) {
      set.add(n);
    }
  };
  add(s);
  for (const part of s.split(/[\s,;|]+/)) {
    add(part);
  }
  const re = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
  let m;
  while ((m = re.exec(s)) !== null) {
    add(m[0]);
  }
  return [...set];
}

function cellMatchesTeacherEmail(cellValue, want) {
  if (!want) {
    return false;
  }
  const inCell = extractEmailsFromCell(cellValue);
  return inCell.includes(want);
}

function findPayslipEmailColumnIndices(columns) {
  const indices = [];
  columns.forEach((c, i) => {
    const s = String(c).trim();
    if (!s) {
      return;
    }
    if (/^e-?mails?$/i.test(s)) {
      indices.push(i);
      return;
    }
    if (/\b(e-?mails?|email\s+address)\b/i.test(s)) {
      indices.push(i);
      return;
    }
    if (/\be\s*mail\b/i.test(s)) {
      indices.push(i);
      return;
    }
    if (/\bemail\b/i.test(s)) {
      indices.push(i);
      return;
    }
    if (/\b(e-?mail|electronic\s+mail)\b/i.test(s)) {
      indices.push(i);
      return;
    }
    if (
      /\b(teacher|contact|work|staff|payee|pay\s*roll|payroll)\b/i.test(s) &&
      /\b(e-?mail|email)\b/i.test(s)
    ) {
      indices.push(i);
    }
  });
  return indices;
}

function filterPayslipsForTeacher(table, teacherEmail) {
  const want = normalizeEmailForPayslip(teacherEmail);
  if (!want) {
    return {
      columns: table.columns || [],
      rows: [],
      pageIds: [],
      noEmailColumn: false,
    };
  }
  const cols = table.columns || [];
  const indices = findPayslipEmailColumnIndices(cols);
  const rows = [];
  const pageIds = [];
  const tableRows = table.rows || [];
  const tablePageIds = table.pageIds || [];
  tableRows.forEach((row, i) => {
    if (!row || !row.length) {
      return;
    }
    const match = row.some((cell) => cellMatchesTeacherEmail(cell, want));
    if (match) {
      rows.push(row);
      pageIds.push(tablePageIds[i] || "");
    }
  });
  return {
    columns: cols,
    rows,
    pageIds,
    noEmailColumn: indices.length === 0 && rows.length === 0,
  };
}

function normalizeNotionUuidLoose(raw) {
  const s = String(raw ?? "")
    .replace(/-/g, "")
    .toLowerCase()
    .trim();
  return /^[0-9a-f]{20,}$/.test(s) ? s : "";
}

function filterPayslipsForNotionPerson(table, personIdRaw) {
  const want = normalizeNotionUuidLoose(personIdRaw);
  if (!want) {
    return {
      columns: table.columns || [],
      rows: [],
      pageIds: [],
      noEmailColumn: false,
    };
  }
  const withHyphens = String(personIdRaw ?? "").trim();
  const cols = table.columns || [];
  const rows = [];
  const pageIds = [];
  const tableRows = table.rows || [];
  const tablePageIds = table.pageIds || [];
  tableRows.forEach((row, i) => {
    if (!row || !row.length) {
      return;
    }
    const pid = normalizeNotionUuidLoose(tablePageIds[i]);
    if (pid && pid === want) {
      rows.push(row);
      pageIds.push(tablePageIds[i] || "");
      return;
    }
    const hay = row
      .map((c) => String(c ?? "").toLowerCase())
      .join(" \n ");
    if (
      hay.includes(want) ||
      (withHyphens.length > 8 && hay.includes(withHyphens.toLowerCase()))
    ) {
      rows.push(row);
      pageIds.push(tablePageIds[i] || "");
    }
  });
  return {
    columns: cols,
    rows,
    pageIds,
    noEmailColumn: false,
  };
}

async function queryTeacherPaySlips(payload) {
  try {
    loadDotenv();
    let email = "", databaseId = "", dataSourceId = "", notionPersonRecordId = "";
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      email = typeof payload.email === "string" ? payload.email.trim() : "";
      databaseId = typeof payload.databaseId === "string" ? payload.databaseId.trim() : "";
      dataSourceId = typeof payload.dataSourceId === "string" ? payload.dataSourceId.trim() : "";
      notionPersonRecordId = typeof payload.notionPersonRecordId === "string" ? payload.notionPersonRecordId.trim() : "";
    } else if (typeof payload === "string") {
      email = payload.trim();
    }
    const hasDedicatedSource = normalizeDatabaseId(databaseId) || normalizeDataSourceId(dataSourceId);
    if (hasDedicatedSource) {
      if (notionPersonRecordId) {
        return await queryNotionTeacherPayslipRowsPartialEnrich({ databaseId, dataSourceId }, email, notionPersonRecordId, { personOnly: true });
      }
      const table = await queryNotionTableForSource({ databaseId, dataSourceId });
      return { ok: true, ...table, noEmailColumn: false };
    }
    return await queryNotionTeacherPayslipRowsPartialEnrich({}, email, notionPersonRecordId, { personOnly: false });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const code = e instanceof Error && "code" in e ? e.code : "UNKNOWN";
    return { ok: false, code, message, columns: [], rows: [], pageIds: [], noEmailColumn: false };
  }
}


const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";
const ALLOWED_ORIGINS = new Set([
  "https://ayaaz777.github.io",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
]);
function corsHeaders(origin) {
  const allow = origin && ALLOWED_ORIGINS.has(origin) ? origin : "https://ayaaz777.github.io";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}
async function getVerifiedEmail(req) {
  const auth = req.headers.get("Authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  if (!token) return "";
  try {
    const res = await fetch(SUPABASE_URL + "/auth/v1/user", {
      headers: { Authorization: "Bearer " + token, apikey: SUPABASE_ANON_KEY },
    });
    if (!res.ok) return "";
    const u = await res.json();
    return typeof u.email === "string" ? u.email.trim() : "";
  } catch { return ""; }
}
Deno.serve(async (req) => {
  const origin = req.headers.get("Origin") || "";
  const baseHeaders = { ...corsHeaders(origin), "Content-Type": "application/json" };
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(origin) });
  if (req.method !== "POST") return new Response(JSON.stringify({ ok: false, message: "Method not allowed" }), { status: 405, headers: baseHeaders });
  const verifiedEmail = await getVerifiedEmail(req);
  if (!verifiedEmail) return new Response(JSON.stringify({ ok: false, noEmail: true, message: "Not authenticated" }), { status: 401, headers: baseHeaders });
  let payload = {};
  try { payload = await req.json(); } catch { payload = {}; }
  if (payload && typeof payload === "object" && !Array.isArray(payload)) { payload.email = verifiedEmail; } else { payload = { email: verifiedEmail }; }
  const result = await queryTeacherPaySlips(payload);
  return new Response(JSON.stringify(result), { headers: baseHeaders });
});

