const DEFAULT_PUBLISHED_PACKAGE_LIMIT = 20;

function toSafeString(value) {
  if (value === null || value === undefined) return '';
  return String(value);
}

function toFiniteNumber(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function normalizePublishedPackageFilters(filters = {}) {
  const source = filters && typeof filters === 'object' ? filters : {};
  return {
    title: toSafeString(source.title),
    subject: toSafeString(source.subject),
    owner: toSafeString(source.owner),
  };
}

function normalizePaginationState(pagination = {}) {
  const source = pagination && typeof pagination === 'object' ? pagination : {};
  return {
    limit: toFiniteNumber(source.limit, DEFAULT_PUBLISHED_PACKAGE_LIMIT),
    offset: toFiniteNumber(source.offset, 0),
  };
}

function serializePublishedPackagesQuery({ filters = {}, pagination = {} } = {}) {
  const normalizedFilters = normalizePublishedPackageFilters(filters);
  const normalizedPagination = normalizePaginationState(pagination);
  return {
    title: normalizedFilters.title,
    subject: normalizedFilters.subject,
    owner: normalizedFilters.owner,
    limit: normalizedPagination.limit,
    offset: normalizedPagination.offset,
  };
}

function normalizePublishedPackageRow(row = {}) {
  const source = row && typeof row === 'object' ? row : {};
  const publishedPackageId = toSafeString(
    source.published_package_id
      ?? source.publishedPackageId
      ?? source.package_id
      ?? source.packageId
  );
  return {
    ...source,
    published_package_id: publishedPackageId,
    title: toSafeString(source.title),
    subject: toSafeString(source.subject),
    published_at: toSafeString(source.published_at ?? source.publishedAt),
    owner_email: toSafeString(source.owner_email ?? source.ownerEmail),
    owner_name: toSafeString(source.owner_name ?? source.ownerName),
    owner_sub: toSafeString(source.owner_sub ?? source.ownerSub),
  };
}

function normalizePublishedPackagesPagePayload(payload = {}) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const rawItems = Array.isArray(source.items) ? source.items : [];
  return {
    items: rawItems.map((item) => normalizePublishedPackageRow(item)),
    hasMore: source.hasMore === true,
    nextOffset: Number.isFinite(Number(source.nextOffset)) ? Number(source.nextOffset) : null,
  };
}

async function fetchPublishedPackagesPage({ apiClient, filters = {}, pagination = {} } = {}) {
  if (!apiClient || typeof apiClient.listPublishedPackages !== 'function') {
    throw new Error('fetchPublishedPackagesPage requires apiClient.listPublishedPackages().');
  }
  const query = serializePublishedPackagesQuery({ filters, pagination });
  const result = await apiClient.listPublishedPackages(query);
  if (!result?.ok) return result;
  return {
    ...result,
    data: normalizePublishedPackagesPagePayload(result.data),
  };
}

function mergePublishedPackageRows({ existingRows = [], incomingRows = [], append = false } = {}) {
  const existing = Array.isArray(existingRows) ? existingRows : [];
  const incoming = Array.isArray(incomingRows) ? incomingRows : [];
  return append ? [...existing, ...incoming] : incoming;
}

export {
  DEFAULT_PUBLISHED_PACKAGE_LIMIT,
  fetchPublishedPackagesPage,
  mergePublishedPackageRows,
  normalizePaginationState,
  normalizePublishedPackageFilters,
  normalizePublishedPackageRow,
  normalizePublishedPackagesPagePayload,
  serializePublishedPackagesQuery,
};
