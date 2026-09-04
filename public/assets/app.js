// ============================================================
// API Orchestrator - Web UI
// ============================================================

const API_BASE = '/admin';

// ---- State ----
let backends = [];
let routes = [];
let databases = [];
let mocks = [];
let eventTargets = [];
let eventsStatusFilter = '';

// ---- Init ----
document.addEventListener('DOMContentLoaded', () => {
  setupTabs();
  setupModal();
  setupTest();
  // Load backends and databases first so routes can resolve their backend names,
  // then load routes and mocks (which depend on backends/routes being present).
  Promise.all([loadBackends(), loadDatabases()])
    .then(() => Promise.all([loadRoutes(), loadMocks()]));

  document.getElementById('add-backend-btn').addEventListener('click', () => {
    document.getElementById('new-backend-panel').classList.remove('hidden');
  });
  document.getElementById('new-backend-cancel').addEventListener('click', () => {
    document.getElementById('new-backend-panel').classList.add('hidden');
  });
  document.getElementById('new-backend-create').addEventListener('click', () => {
    const authType = document.getElementById('new-backend-auth-type').value;
    document.getElementById('new-backend-panel').classList.add('hidden');
    createNewBackend(authType);
  });
  document.getElementById('add-route-btn').addEventListener('click', () => {
    populateRouteBackendSelect();
    document.getElementById('new-route-panel').classList.remove('hidden');
  });
  document.getElementById('new-route-cancel').addEventListener('click', () => {
    document.getElementById('new-route-panel').classList.add('hidden');
  });
  document.getElementById('new-route-create').addEventListener('click', () => {
    const stepType = document.getElementById('new-route-step-type').value;
    const backendId = document.getElementById('new-route-backend').value;
    document.getElementById('new-route-panel').classList.add('hidden');
    createNewRoute(stepType, backendId);
  });
  document.getElementById('new-route-step-type').addEventListener('change', () => {
    populateRouteBackendSelect();
  });
  document.getElementById('add-database-btn').addEventListener('click', () => openDatabaseEditor(null));
  document.getElementById('add-mock-btn').addEventListener('click', () => {
    const select = document.getElementById('new-mock-route');
    select.innerHTML = routes.map((r) => `<option value="${r.id}">${escapeHtml(r.method)} ${escapeHtml(r.path)} — ${escapeHtml(r.name)}</option>`).join('');
    document.getElementById('new-mock-panel').classList.remove('hidden');
  });
  document.getElementById('new-mock-cancel').addEventListener('click', () => {
    document.getElementById('new-mock-panel').classList.add('hidden');
  });
  document.getElementById('new-mock-create').addEventListener('click', async () => {
    const routeId = document.getElementById('new-mock-route').value;
    document.getElementById('new-mock-panel').classList.add('hidden');
    await createNewMock(routeId);
  });
  document.getElementById('refresh-logs-btn').addEventListener('click', loadLogs);
  document.getElementById('clear-logs-btn').addEventListener('click', clearLogs);
  document.getElementById('logs-route-filter').addEventListener('change', (e) => {
    logsRouteFilter = e.target.value;
    logsPage = 1;
    loadLogs();
  });
  // Events
  document.getElementById('refresh-events-btn').addEventListener('click', loadEvents);
  document.getElementById('events-status-filter').addEventListener('change', (e) => {
    eventsStatusFilter = e.target.value;
    loadEvents();
  });
  // Event Targets
  document.getElementById('add-event-target-btn').addEventListener('click', () => {
    document.getElementById('new-event-target-panel').classList.remove('hidden');
  });
  document.getElementById('new-event-target-cancel').addEventListener('click', () => {
    document.getElementById('new-event-target-panel').classList.add('hidden');
  });
  document.getElementById('new-event-target-create').addEventListener('click', () => {
    const type = document.getElementById('new-event-target-type').value;
    document.getElementById('new-event-target-panel').classList.add('hidden');
    createNewEventTarget(type);
  });
  document.getElementById('search-event-targets').addEventListener('input', (e) => {
    filterCards('event-targets-list', e.target.value);
  });
  // Received Webhooks
  document.getElementById('refresh-received-webhooks-btn').addEventListener('click', loadReceivedWebhooks);
  document.getElementById('clear-received-webhooks-btn').addEventListener('click', clearReceivedWebhooks);
  document.getElementById('refresh-audit-btn').addEventListener('click', loadAudit);
  document.getElementById('clear-audit-btn').addEventListener('click', clearAudit);
  document.getElementById('audit-filter-type').addEventListener('change', loadAudit);
  document.getElementById('refresh-performance-btn').addEventListener('click', loadPerformance);
  document.getElementById('export-btn').addEventListener('click', exportConfig);
  document.getElementById('import-btn').addEventListener('click', () => document.getElementById('import-file').click());
  document.getElementById('import-file').addEventListener('change', importConfig);
  document.getElementById('logout-btn').addEventListener('click', async () => {
    await fetch('/logout', { method: 'POST' });
    window.location.href = '/ui/login.html';
  });
});

// ---- Tabs ----
function setupTabs() {
  const buttons = document.querySelectorAll('.nav-btn');
  buttons.forEach((btn) => {
    btn.addEventListener('click', () => {
      buttons.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');

      document.querySelectorAll('.tab-content').forEach((t) => t.classList.remove('active'));
      document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');

      // Update URL hash
      window.history.replaceState(null, '', `#${btn.dataset.tab}`);

      // Load data on tab switch
      if (btn.dataset.tab === 'logs') loadLogs();
      if (btn.dataset.tab === 'events') loadEvents();
      if (btn.dataset.tab === 'event-targets') loadEventTargets();
      if (btn.dataset.tab === 'received-webhooks') loadReceivedWebhooks();
      if (btn.dataset.tab === 'audit') loadAudit();
      if (btn.dataset.tab === 'docs') loadDocsIndex();
      if (btn.dataset.tab === 'performance') loadPerformance();
    });
  });

  // Search bars
  document.getElementById('search-backends').addEventListener('input', (e) => {
    filterCards('backends-list', e.target.value);
  });
  document.getElementById('search-routes').addEventListener('input', (e) => {
    filterCards('routes-list', e.target.value);
  });
  document.getElementById('search-databases').addEventListener('input', (e) => {
    filterCards('databases-list', e.target.value);
  });
  document.getElementById('search-mocks').addEventListener('input', (e) => {
    filterCards('mocks-list', e.target.value);
  });

  // Docs search
  let docsDebounce;
  document.getElementById('search-docs').addEventListener('input', (e) => {
    clearTimeout(docsDebounce);
    docsDebounce = setTimeout(() => searchDocs(e.target.value), 300);
  });

  // URL-based tab routing
  function activateTabFromHash() {
    const hash = window.location.hash.replace('#', '') || 'backends';
    const btn = document.querySelector(`.nav-btn[data-tab="${hash}"]`);
    if (btn) btn.click();
  }
  window.addEventListener('hashchange', activateTabFromHash);
  activateTabFromHash();
}

function filterCards(containerId, query) {
  const container = document.getElementById(containerId);
  const cards = container.querySelectorAll('.card');
  const q = query.toLowerCase();
  cards.forEach((card) => {
    const text = card.textContent.toLowerCase();
    card.style.display = text.includes(q) ? '' : 'none';
  });
}

// ---- Backends ----
async function loadBackends() {
  try {
    const res = await fetch(`${API_BASE}/backends`);
    const data = await res.json();
    backends = data.backends || [];
    renderBackends();
    // Re-render routes so their backend name badges resolve correctly
    if (routes.length > 0) renderRoutes();
  } catch (err) {
    console.error('Failed to load backends:', err);
  }
}

function renderBackends() {
  const container = document.getElementById('backends-list');
  if (backends.length === 0) {
    container.innerHTML = '<p style="color: var(--text-muted); padding: 20px;">No backends configured. Click "Add Backend" to get started.</p>';
    return;
  }

  container.innerHTML = backends.map((b) => `
    <div class="card" data-id="${b.id}">
      <div class="card-info">
        <h4>${escapeHtml(b.name)} <span class="badge badge-auth">${b.auth?.type || 'none'}</span></h4>
        <p>${escapeHtml(b.baseUrl)} ${b.timeout ? `• timeout: ${b.timeout}ms` : ''}</p>
      </div>
      <div class="card-actions">
        <button class="btn btn-secondary btn-sm" onclick="viewBackend('${b.id}')">View</button>
        <button class="btn btn-secondary btn-sm" onclick="openBackendEditor('${b.id}')">Edit</button>
        <button class="btn btn-danger btn-sm" onclick="deleteBackend('${b.id}')">Delete</button>
      </div>
    </div>
  `).join('');
}

function openBackendEditor(id) {
  const existing = id ? backends.find((b) => b.id === id) : null;

  if (existing) {
    openModal(
      `Edit Backend: ${existing.name}`,
      JSON.stringify(existing, null, 2),
      async (json) => {
        const backend = JSON.parse(json);
        await fetch(`${API_BASE}/backends/${backend.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(backend),
        });
        await loadBackends();
      }
    );
  }
}

function createNewBackend(authType) {
  const authTemplates = {
    'none': { type: 'none' },
    'api-key': { type: 'api-key', headerName: 'X-API-Key', token: 'your-api-key' },
    'bearer': { type: 'bearer', token: 'your-bearer-token' },
    'basic': { type: 'basic', username: 'your-username', password: 'your-password' },
    'oauth2': { type: 'oauth2', oauth2: { tokenUrl: 'https://auth.example.com/oauth/token', clientId: 'your-client-id', clientSecret: 'your-client-secret', scope: '' } },
    'passthrough': { type: 'none' },
  };

  const template = {
    name: 'My Backend',
    baseUrl: 'https://api.example.com',
    auth: authTemplates[authType] || authTemplates['none'],
    defaultHeaders: {},
    timeout: 10000,
    retry: { maxRetries: 3, initialDelayMs: 500, backoffMultiplier: 2 }
  };

  openModal(
    'New Backend',
    JSON.stringify(template, null, 2),
    async (json) => {
      const backend = JSON.parse(json);
      await fetch(`${API_BASE}/backends`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(backend),
      });
      await loadBackends();
    }
  );
}

async function deleteBackend(id) {
  if (!confirm('Delete this backend? Routes referencing it will break.')) return;
  await fetch(`${API_BASE}/backends/${id}`, { method: 'DELETE' });
  await loadBackends();
}

function viewBackend(id) {
  const existing = backends.find((b) => b.id === id);
  if (existing) {
    openModalReadOnly(`View Backend: ${existing.name}`, JSON.stringify(existing, null, 2));
  }
}

// ---- Routes ----
async function loadRoutes() {
  try {
    const res = await fetch(`${API_BASE}/routes`);
    const data = await res.json();
    routes = data.routes || [];
    renderRoutes();
  } catch (err) {
    console.error('Failed to load routes:', err);
  }
}

function getRouteBackendNames(route) {
  const names = new Set();
  (route.steps || []).forEach((step) => {
    (step.calls || []).forEach((call) => {
      if (call.backendId) {
        const b = backends.find((b) => b.id === call.backendId);
        names.add(b ? b.name : call.backendId);
      }
    });
    if (step.fallbackCalls) {
      step.fallbackCalls.forEach((call) => {
        if (call.backendId) {
          const b = backends.find((b) => b.id === call.backendId);
          names.add(b ? b.name : call.backendId);
        }
      });
    }
    if (step.database && step.database.connectionId) {
      const db = databases.find((d) => d.id === step.database.connectionId);
      names.add(db ? db.name : step.database.connectionId);
    }
  });
  return [...names];
}

function renderRoutes() {
  const container = document.getElementById('routes-list');
  if (routes.length === 0) {
    container.innerHTML = '<p style="color: var(--text-muted); padding: 20px;">No routes configured. Click "Add Route" to create an orchestration.</p>';
    return;
  }

  container.innerHTML = routes.map((r) => {
    const backendNames = getRouteBackendNames(r);
    const backendBadges = backendNames.length > 0
      ? backendNames.map((name) => `<span class="badge badge-auth">${escapeHtml(name)}</span>`).join(' ')
      : '<span style="color: var(--text-muted); font-size: 0.8rem;">none</span>';
    return `
    <div class="card" data-id="${r.id}">
      <div class="card-info">
        <h4>
          <span class="badge badge-method">${r.method}</span>
          ${escapeHtml(r.path)}
          — ${escapeHtml(r.name)}
        </h4>
        <p>${r.steps?.length || 0} steps • ${backendBadges} • ${r.description ? escapeHtml(r.description.slice(0, 80)) : 'No description'}</p>
      </div>
      <div class="card-actions">
        <button class="btn btn-secondary btn-sm" onclick="viewRoute('${r.id}')">View</button>
        <button class="btn btn-secondary btn-sm" onclick="openRouteEditor('${r.id}')">Edit</button>
        <button class="btn btn-danger btn-sm" onclick="deleteRoute('${r.id}')">Delete</button>
      </div>
    </div>
  `}).join('');
}

function openRouteEditor(id) {
  const existing = id ? routes.find((r) => r.id === id) : null;

  if (existing) {
    openModal(
      `Edit Route: ${existing.name}`,
      JSON.stringify(existing, null, 2),
      async (json) => {
        const route = JSON.parse(json);
        await fetch(`${API_BASE}/routes/${route.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(route),
        });
        await loadRoutes();
      }
    );
  }
}

function populateRouteBackendSelect() {
  const stepType = document.getElementById('new-route-step-type').value;
  const select = document.getElementById('new-route-backend');
  const isDb = stepType === 'database' || stepType === 'procedure';

  if (isDb) {
    select.innerHTML = databases.map((d) => `<option value="${d.id}">${escapeHtml(d.name)}</option>`).join('');
  } else {
    select.innerHTML = backends.map((b) => `<option value="${b.id}">${escapeHtml(b.name)}</option>`).join('');
  }
}

function createNewRoute(stepType, backendOrDbId) {
  const isDb = stepType === 'database' || stepType === 'procedure';
  let template;

  if (isDb) {
    template = {
      name: 'My Route',
      method: 'GET',
      path: '/example/:id',
      description: 'Describe what this route does',
      logLevel: 'error',
      steps: [
        {
          type: stepType,
          calls: [],
          database: {
            stepId: 'step-1',
            connectionId: backendOrDbId,
            [stepType === 'procedure' ? 'procedure' : 'query']: stepType === 'procedure' ? 'dbo.YourProcedureName' : 'SELECT * FROM yourTable WHERE id = :id',
            params: {
              id: '$.inboundRequest.params.id'
            }
          }
        }
      ],
      responseMapping: {
        statusCode: 200,
        body: {
          result: '$steps.step-1.body'
        }
      }
    };
  } else {
    const stepTemplate = {
      type: stepType,
      calls: [
        {
          stepId: 'step-1',
          backendId: backendOrDbId,
          method: 'GET',
          path: '/resource/{{$.inboundRequest.params.id}}'
        }
      ]
    };

    if (stepType === 'forEach') {
      stepTemplate.iterateOver = '$steps.step-1.body.results';
      stepTemplate.calls[0].stepId = 'step-2';
      stepTemplate.calls[0].path = '{{$item.links.detail}}';
      template = {
        name: 'My Route',
        method: 'GET',
        path: '/example/:id',
        description: 'Describe what this route does',
        logLevel: 'error',
        steps: [
          {
            type: 'sequential',
            calls: [{ stepId: 'step-1', backendId: backendOrDbId, method: 'GET', path: '/resource/{{$.inboundRequest.params.id}}' }]
          },
          stepTemplate
        ],
        responseMapping: { statusCode: 200, body: { result: '$steps.step-1.body' } }
      };
    } else if (stepType === 'conditional') {
      stepTemplate.condition = { expression: '$steps.step-0.body.status', operator: 'eq', value: 'active' };
      stepTemplate.fallbackCalls = [];
      template = {
        name: 'My Route',
        method: 'GET',
        path: '/example/:id',
        description: 'Describe what this route does',
        logLevel: 'error',
        steps: [stepTemplate],
        responseMapping: { statusCode: 200, body: { result: '$steps.step-1.body' } }
      };
    } else {
      template = {
        name: 'My Route',
        method: 'GET',
        path: '/example/:id',
        description: 'Describe what this route does',
        logLevel: 'error',
        steps: [stepTemplate],
        responseMapping: { statusCode: 200, body: { result: '$steps.step-1.body' } }
      };
    }
  }

  openModal(
    'New Route',
    JSON.stringify(template, null, 2),
    async (json) => {
      const route = JSON.parse(json);
      await fetch(`${API_BASE}/routes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(route),
      });
      await loadRoutes();
    }
  );
}

async function deleteRoute(id) {
  if (!confirm('Delete this route?')) return;
  await fetch(`${API_BASE}/routes/${id}`, { method: 'DELETE' });
  await loadRoutes();
}

function viewRoute(id) {
  const existing = routes.find((r) => r.id === id);
  if (existing) {
    openModalReadOnly(`View Route: ${existing.name}`, JSON.stringify(existing, null, 2));
  }
}

// ---- Databases ----
async function loadDatabases() {
  try {
    const res = await fetch(`${API_BASE}/databases`);
    const data = await res.json();
    databases = data.databases || [];
    renderDatabases();
  } catch (err) {
    console.error('Failed to load databases:', err);
  }
}

function renderDatabases() {
  const container = document.getElementById('databases-list');
  if (databases.length === 0) {
    container.innerHTML = '<p style="color: var(--text-muted); padding: 20px;">No database connections configured. Click "Add Database" to get started.</p>';
    return;
  }

  container.innerHTML = databases.map((d) => `
    <div class="card" data-id="${d.id}">
      <div class="card-info">
        <h4>${escapeHtml(d.name)} <span class="badge badge-auth">${d.type}</span></h4>
        <p>${escapeHtml(d.host)}:${d.port} / ${escapeHtml(d.database)}</p>
      </div>
      <div class="card-actions">
        <button class="btn btn-secondary btn-sm" onclick="viewDatabase('${d.id}')">View</button>
        <button class="btn btn-secondary btn-sm" onclick="openDatabaseEditor('${d.id}')">Edit</button>
        <button class="btn btn-danger btn-sm" onclick="deleteDatabase('${d.id}')">Delete</button>
      </div>
    </div>
  `).join('');
}

function openDatabaseEditor(id) {
  const existing = id ? databases.find((d) => d.id === id) : null;
  const template = existing || {
    name: 'My Database',
    type: 'mssql',
    host: 'localhost',
    port: 1433,
    database: 'MyDatabase',
    username: 'sa',
    password: '',
    options: {
      encrypt: false,
      trustServerCertificate: true
    }
  };

  openModal(
    existing ? `Edit Database: ${existing.name}` : 'New Database Connection',
    JSON.stringify(template, null, 2),
    async (json) => {
      const database = JSON.parse(json);
      if (existing) {
        await fetch(`${API_BASE}/databases/${database.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(database),
        });
      } else {
        await fetch(`${API_BASE}/databases`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(database),
        });
      }
      await loadDatabases();
    }
  );
}

async function deleteDatabase(id) {
  if (!confirm('Delete this database connection?')) return;
  await fetch(`${API_BASE}/databases/${id}`, { method: 'DELETE' });
  await loadDatabases();
}

function viewDatabase(id) {
  const existing = databases.find((d) => d.id === id);
  if (existing) {
    openModalReadOnly(`View Database: ${existing.name}`, JSON.stringify(existing, null, 2));
  }
}

// ---- Mocks ----
async function loadMocks() {
  try {
    const res = await fetch(`${API_BASE}/mocks`);
    const data = await res.json();
    mocks = data.mocks || [];
    renderMocks();
  } catch (err) {
    console.error('Failed to load mocks:', err);
  }
}

function renderMocks() {
  const container = document.getElementById('mocks-list');
  if (mocks.length === 0) {
    container.innerHTML = '<p style="color: var(--text-muted); padding: 20px;">No mocks configured. Click "Add Mock" to create one.</p>';
    return;
  }

  container.innerHTML = mocks.map((m) => {
    const route = routes.find((r) => r.id === m.routeId);
    const method = (m.request && m.request.method) || (route && route.method) || 'GET';
    const path = (m.request && m.request.path) || (route && route.path) || m.routeId;
    const routeLabel = `${method} /${path.replace(/^\//, '')}`;
    return `
    <div class="card" data-id="${m.id}">
      <div class="card-info">
        <h4>${escapeHtml(m.name)} <span class="badge ${m.active ? 'badge-method' : 'badge-auth'}">${m.active ? 'Active' : 'Inactive'}</span></h4>
        <p>${escapeHtml(routeLabel)} • ${m.response.statusCode}</p>
      </div>
      <div class="card-actions">
        <button class="btn btn-secondary btn-sm" onclick="viewMock('${m.id}')">View</button>
        <button class="btn btn-secondary btn-sm" onclick="editMock('${m.id}')">Edit</button>
        <button class="btn btn-secondary btn-sm" onclick="toggleMock('${m.id}')">${m.active ? 'Disable' : 'Enable'}</button>
        <button class="btn btn-danger btn-sm" onclick="deleteMock('${m.id}')">Delete</button>
      </div>
    </div>
  `;
  }).join('');
}

async function createNewMock(routeId) {
  try {
    const res = await fetch(`${API_BASE}/mocks/template/${routeId}`);
    const template = await res.json();

    openModal(
      'New Mock',
      JSON.stringify(template, null, 2),
      async (json) => {
        const mock = JSON.parse(json);
        await fetch(`${API_BASE}/mocks`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(mock),
        });
        await loadMocks();
      }
    );
  } catch (err) {
    alert('Failed to generate mock template: ' + err.message);
  }
}

function viewMock(id) {
  const mock = mocks.find((m) => m.id === id);
  if (!mock) return;
  try {
    const content = JSON.stringify(mock, null, 2);
    openModalReadOnly(`View Mock: ${mock.name}`, content);
  } catch {
    const safeMock = { ...mock, response: { ...mock.response, body: '[Binary or non-JSON content]' } };
    openModalReadOnly(`View Mock: ${mock.name}`, JSON.stringify(safeMock, null, 2));
  }
}

function editMock(id) {
  const mock = mocks.find((m) => m.id === id);
  if (!mock) return;
  let content;
  try {
    content = JSON.stringify(mock, null, 2);
    JSON.parse(content);
  } catch {
    const safeMock = { ...mock, response: { ...mock.response, body: '[Binary or non-JSON content - replace with valid JSON]' } };
    content = JSON.stringify(safeMock, null, 2);
  }
  openModal(
    `Edit Mock: ${mock.name}`,
    content,
    async (json) => {
      const updated = JSON.parse(json);
      await fetch(`${API_BASE}/mocks/${updated.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updated),
      });
      await loadMocks();
    }
  );
}

async function toggleMock(id) {
  const mock = mocks.find((m) => m.id === id);
  if (!mock) return;
  mock.active = !mock.active;
  await fetch(`${API_BASE}/mocks/${mock.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(mock),
  });
  await loadMocks();
}

async function deleteMock(id) {
  if (!confirm('Delete this mock?')) return;
  await fetch(`${API_BASE}/mocks/${id}`, { method: 'DELETE' });
  await loadMocks();
}

// ---- Logs ----
let logsPage = 1;
let logsRouteFilter = '';
const logsPerPage = 50;

async function loadLogs(page) {
  if (page !== undefined) logsPage = page;
  try {
    const routeParam = logsRouteFilter ? `&route=${encodeURIComponent(logsRouteFilter)}` : '';
    const res = await fetch(`${API_BASE}/logs?limit=${logsPerPage}&page=${logsPage}${routeParam}`);
    const data = await res.json();
    renderLogs(data.logs || [], data.pagination);
    // Populate route filter dropdown
    populateLogsRouteFilter();
  } catch (err) {
    console.error('Failed to load logs:', err);
  }
}

async function populateLogsRouteFilter() {
  const select = document.getElementById('logs-route-filter');
  if (select.options.length > 1) return; // Already populated
  try {
    const res = await fetch(`${API_BASE}/performance`);
    const data = await res.json();
    const routes = data.performance || [];
    routes.forEach(r => {
      const opt = document.createElement('option');
      opt.value = r.routeId;
      opt.textContent = r.routeName;
      if (r.routeId === logsRouteFilter) opt.selected = true;
      select.appendChild(opt);
    });
  } catch { /* ignore */ }
}

function filterLogsByRoute(routeId) {
  logsRouteFilter = routeId;
  logsPage = 1;
  // Reset dropdown options so it repopulates
  const select = document.getElementById('logs-route-filter');
  select.innerHTML = '<option value="">All Routes</option>';
  loadLogs();
}

async function clearLogs() {
  if (!confirm('Clear all execution logs?')) return;
  try {
    await fetch(`${API_BASE}/logs`, { method: 'DELETE' });
    loadLogs();
  } catch (err) {
    alert('Failed to clear logs: ' + err.message);
  }
}

function renderLogs(logs, pagination) {
  const container = document.getElementById('logs-list');
  if (logs.length === 0 && (!pagination || pagination.total === 0)) {
    container.innerHTML = '<p style="color: var(--text-muted); padding: 20px;">No execution logs yet. Send a request to /api/* to see logs here.</p>';
    return;
  }

  let paginationHtml = '';
  if (pagination && pagination.totalPages > 1) {
    paginationHtml = `<div style="display: flex; justify-content: space-between; align-items: center; padding: 12px 0;">
      <span style="color: var(--text-muted); font-size: 0.85rem;">Showing ${(pagination.page - 1) * pagination.limit + 1}–${Math.min(pagination.page * pagination.limit, pagination.total)} of ${pagination.total}</span>
      <div style="display: flex; gap: 8px;">
        <button class="btn btn-secondary btn-sm" ${pagination.page <= 1 ? 'disabled' : ''} onclick="loadLogs(1)">First</button>
        <button class="btn btn-secondary btn-sm" ${pagination.page <= 1 ? 'disabled' : ''} onclick="loadLogs(${pagination.page - 1})">Prev</button>
        <span style="color: var(--text); padding: 4px 8px;">Page ${pagination.page} of ${pagination.totalPages}</span>
        <button class="btn btn-secondary btn-sm" ${pagination.page >= pagination.totalPages ? 'disabled' : ''} onclick="loadLogs(${pagination.page + 1})">Next</button>
        <button class="btn btn-secondary btn-sm" ${pagination.page >= pagination.totalPages ? 'disabled' : ''} onclick="loadLogs(${pagination.totalPages})">Last</button>
      </div>
    </div>`;
  }

  container.innerHTML = paginationHtml + `
    <table>
      <thead>
        <tr>
          <th>Time</th>
          <th>Route</th>
          <th>Method</th>
          <th>Path</th>
          <th>Status</th>
          <th>Duration</th>
          <th>Backend</th>
          <th>Overhead</th>
          <th>Error</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        ${logs.map((log) => {
          let backendTime = '—';
          let overhead = '—';
          if (log.step_results) {
            try {
              const steps = JSON.parse(log.step_results);
              if (steps._backendWallTime !== undefined) {
                backendTime = steps._backendWallTime + 'ms';
                overhead = Math.max(0, log.duration_ms - steps._backendWallTime) + 'ms';
              } else {
                let stepSum = 0;
                for (const [key, val] of Object.entries(steps)) {
                  if (key === '_backendWallTime') continue;
                  if (val && typeof val.duration === 'number') stepSum += val.duration;
                }
                backendTime = stepSum + 'ms';
                overhead = Math.max(0, log.duration_ms - stepSum) + 'ms';
              }
            } catch {}
          }
          return `
          <tr>
            <td>${new Date(log.created_at).toLocaleString()}</td>
            <td>${escapeHtml(log.route_name || '')}</td>
            <td>${log.inbound_method}</td>
            <td>${escapeHtml(log.inbound_path)}</td>
            <td><span class="status-badge status-${statusClass(log.status_code)}">${log.status_code}</span></td>
            <td>${log.duration_ms}ms</td>
            <td>${backendTime}</td>
            <td>${overhead}</td>
            <td>${log.error ? escapeHtml(log.error.slice(0, 50)) : '—'}</td>
            <td><button class="btn btn-secondary btn-sm" onclick="viewLogEntry(${log.id})">View</button></td>
          </tr>
        `}).join('')}
      </tbody>
    </table>
  ` + paginationHtml;
}

async function viewLogEntry(id) {
  try {
    const res = await fetch(`${API_BASE}/logs/${id}`);
    const entry = await res.json();
    const safeParse = (str) => { try { return str ? JSON.parse(str) : null; } catch { return str; } };
    const display = {
      route: entry.route_name || entry.route_id,
      timestamp: entry.created_at,
      method: entry.inbound_method,
      path: entry.inbound_path,
      query: safeParse(entry.inbound_query),
      statusCode: entry.status_code,
      duration: `${entry.duration_ms}ms`,
      error: entry.error || null,
      inboundHeaders: safeParse(entry.inbound_headers),
      inboundBody: safeParse(entry.inbound_body),
      responseBody: safeParse(entry.response_body),
      stepResults: safeParse(entry.step_results),
    };
    openModalReadOnly(`Log: ${entry.inbound_method} ${entry.inbound_path}`, JSON.stringify(display, null, 2));
  } catch (err) {
    alert('Failed to load log entry: ' + err.message);
  }
}

function statusClass(code) {
  if (code >= 200 && code < 300) return '2xx';
  if (code >= 400 && code < 500) return '4xx';
  return '5xx';
}

// ---- Audit ----
async function loadAudit() {
  try {
    const entityType = document.getElementById('audit-filter-type').value;
    const params = new URLSearchParams({ limit: '100' });
    if (entityType) params.set('entityType', entityType);
    const res = await fetch(`${API_BASE}/audit?${params}`);
    const data = await res.json();
    renderAudit(data.audit || []);
  } catch (err) {
    console.error('Failed to load audit:', err);
  }
}

async function clearAudit() {
  if (!confirm('Clear audit history? (The latest change for each record will be retained)')) return;
  try {
    await fetch(`${API_BASE}/audit`, { method: 'DELETE' });
    loadAudit();
  } catch (err) {
    alert('Failed to clear audit: ' + err.message);
  }
}

function renderAudit(entries) {
  const container = document.getElementById('audit-list');
  if (entries.length === 0) {
    container.innerHTML = '<p style="color: var(--text-muted); padding: 20px;">No audit history yet.</p>';
    return;
  }

  container.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Time</th>
          <th>Type</th>
          <th>Name</th>
          <th>Action</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        ${entries.map((entry) => `
          <tr>
            <td>${new Date(entry.timestamp).toLocaleString()}</td>
            <td>${entry.entityType}</td>
            <td>${escapeHtml(entry.entityName)}</td>
            <td><span class="audit-action audit-action-${entry.action}">${entry.action}</span></td>
            <td>
              <button class="btn btn-secondary btn-sm" onclick="viewAuditEntry(${entry.id})">View</button>
              ${entry.previousConfig ? `<button class="btn btn-secondary btn-sm" onclick="rollbackAudit(${entry.id})">Rollback</button>` : ''}
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

async function viewAuditEntry(id) {
  try {
    const res = await fetch(`${API_BASE}/audit/${id}`);
    const entry = await res.json();
    const content = {
      action: entry.action,
      timestamp: entry.timestamp,
      entityType: entry.entityType,
      entityName: entry.entityName,
      previousConfig: entry.previousConfig ? JSON.parse(entry.previousConfig) : null,
      newConfig: entry.newConfig ? JSON.parse(entry.newConfig) : null,
    };
    openModalReadOnly(`Audit: ${entry.action} ${entry.entityName}`, JSON.stringify(content, null, 2));
  } catch (err) {
    alert('Failed to load audit entry');
  }
}

async function rollbackAudit(id) {
  if (!confirm('Rollback this entity to its previous configuration?')) return;
  try {
    const res = await fetch(`${API_BASE}/audit/${id}/rollback`, { method: 'POST' });
    const data = await res.json();
    if (res.ok) {
      alert(data.message);
      loadAudit();
      loadBackends();
      loadRoutes();
      loadDatabases();
    } else {
      alert(data.error);
    }
  } catch (err) {
    alert('Rollback failed: ' + err.message);
  }
}

// ---- Test Panel ----
function setupTest() {
  document.getElementById('send-test-btn').addEventListener('click', sendTestRequest);
}

async function sendTestRequest() {
  const method = document.getElementById('test-method').value;
  const path = document.getElementById('test-path').value;
  const headersRaw = document.getElementById('test-headers').value;
  const bodyRaw = document.getElementById('test-body').value;

  const statusEl = document.getElementById('test-response-status');
  const bodyEl = document.getElementById('test-response-body');

  statusEl.textContent = 'Sending...';
  bodyEl.textContent = '';

  try {
    const headers = JSON.parse(headersRaw);
    const fetchOpts = { method, headers };

    if (method !== 'GET' && method !== 'DELETE') {
      fetchOpts.body = bodyRaw;
    }

    const res = await fetch(path, fetchOpts);
    const responseBody = await res.text();

    statusEl.innerHTML = `<span class="status-badge status-${statusClass(res.status)}">${res.status} ${res.statusText}</span>`;

    try {
      bodyEl.textContent = JSON.stringify(JSON.parse(responseBody), null, 2);
    } catch {
      bodyEl.textContent = responseBody;
    }
  } catch (err) {
    statusEl.textContent = 'Error';
    bodyEl.textContent = err.message;
  }
}

// ---- Modal ----
let modalSaveCallback = null;

function setupModal() {
  document.querySelector('.modal-overlay').addEventListener('click', closeModal);
  document.querySelector('.modal-close').addEventListener('click', closeModal);
  document.getElementById('modal-cancel').addEventListener('click', closeModal);
  document.getElementById('modal-copy').addEventListener('click', () => {
    const editor = document.getElementById('modal-editor');
    navigator.clipboard.writeText(editor.value).then(() => {
      const btn = document.getElementById('modal-copy');
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
    }).catch(() => {
      // Fallback for older browsers
      editor.select();
      document.execCommand('copy');
      const btn = document.getElementById('modal-copy');
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
    });
  });
  document.getElementById('modal-save').addEventListener('click', () => {
    const json = document.getElementById('modal-editor').value;
    const error = validateJson(json);
    if (!error) {
      if (modalSaveCallback) modalSaveCallback(json);
      closeModal();
    } else {
      showJsonError(error);
    }
  });

  // Live validation on input
  const editor = document.getElementById('modal-editor');
  editor.addEventListener('input', () => {
    const json = editor.value;
    const error = validateJson(json);
    const errorEl = document.getElementById('modal-error');
    if (error) {
      errorEl.textContent = error.message;
      errorEl.classList.remove('hidden');
      updateLineNumbers(error.line);
    } else {
      errorEl.textContent = '';
      errorEl.classList.add('hidden');
      updateLineNumbers(null);
    }
  });

  // Sync scroll between line numbers and editor
  editor.addEventListener('scroll', () => {
    document.getElementById('line-numbers').scrollTop = editor.scrollTop;
  });

  // Bracket matching on cursor move
  editor.addEventListener('click', updateBracketStatus);
  editor.addEventListener('keyup', updateBracketStatus);
}

function validateJson(json) {
  try {
    JSON.parse(json);
    return null;
  } catch (err) {
    // Try to extract position info
    const match = err.message.match(/position (\d+)/);
    if (match) {
      const position = parseInt(match[1]);
      const lines = json.substring(0, position).split('\n');
      const line = lines.length;
      const col = lines[lines.length - 1].length + 1;
      const context = json.substring(Math.max(0, position - 20), Math.min(json.length, position + 20));
      return {
        message: `Line ${line}, Col ${col}: ${err.message}\n→ ...${context}...`,
        line,
        col,
        position
      };
    }
    return { message: err.message, line: null, col: null, position: null };
  }
}

function showJsonError(error) {
  const errorEl = document.getElementById('modal-error');
  errorEl.textContent = error.message;
  errorEl.classList.remove('hidden');
  updateLineNumbers(error.line);

  // Try to scroll/focus to error position
  if (error.position !== null) {
    const editor = document.getElementById('modal-editor');
    editor.focus();
    editor.setSelectionRange(error.position, error.position + 1);
  }
}

function openModal(title, content, onSave) {
  document.getElementById('modal-title').textContent = title;
  const editor = document.getElementById('modal-editor');
  editor.value = content;
  editor.readOnly = false;
  document.getElementById('modal').classList.remove('hidden');
  document.getElementById('modal-error').classList.add('hidden');
  document.getElementById('modal-save').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  modalSaveCallback = onSave;
  updateLineNumbers();
}

function openModalReadOnly(title, content) {
  document.getElementById('modal-title').textContent = title;
  const editor = document.getElementById('modal-editor');
  editor.value = content;
  editor.readOnly = true;
  document.getElementById('modal').classList.remove('hidden');
  document.getElementById('modal-error').classList.add('hidden');
  document.getElementById('modal-save').classList.add('hidden');
  document.body.style.overflow = 'hidden';
  modalSaveCallback = null;
  updateLineNumbers();
}

function closeModal() {
  document.getElementById('modal').classList.add('hidden');
  document.body.style.overflow = '';
  modalSaveCallback = null;
}

function updateLineNumbers(errorLine) {
  const editor = document.getElementById('modal-editor');
  const lineNumbersEl = document.getElementById('line-numbers');
  const lines = editor.value.split('\n');
  lineNumbersEl.innerHTML = lines.map((_, i) => {
    const num = i + 1;
    const cls = num === errorLine ? 'error-line' : '';
    return `<span class="${cls}">${num}</span>`;
  }).join('');
}

function updateBracketStatus() {
  const editor = document.getElementById('modal-editor');
  const statusEl = document.getElementById('bracket-status');
  const pos = editor.selectionStart;
  const text = editor.value;

  // Get current line and column
  const beforeCursor = text.substring(0, pos);
  const lines = beforeCursor.split('\n');
  const line = lines.length;
  const col = lines[lines.length - 1].length + 1;

  // Find bracket context
  const charAtCursor = text[pos];
  const charBeforeCursor = text[pos - 1];

  let info = `<span class="bracket-info">Ln ${line}, Col ${col}</span>`;

  // Check if cursor is on a bracket
  const openBrackets = { '{': '}', '[': ']' };
  const closeBrackets = { '}': '{', ']': '[' };

  if (charAtCursor && openBrackets[charAtCursor]) {
    // On an opening bracket — find its matching close
    const match = findMatchingClose(text, pos, charAtCursor, openBrackets[charAtCursor]);
    if (match !== -1) {
      const matchLines = text.substring(0, match).split('\n');
      const matchLine = matchLines.length;
      const matchCol = matchLines[matchLines.length - 1].length + 1;
      info += ` — <span class="bracket-match">Opening ${charAtCursor} matches closing at Ln ${matchLine}, Col ${matchCol}</span>`;
    } else {
      info += ` — <span class="bracket-error">No matching ${openBrackets[charAtCursor]} found</span>`;
    }
  } else if (charBeforeCursor && closeBrackets[charBeforeCursor]) {
    // Just after a closing bracket — find its matching open
    const match = findMatchingOpen(text, pos - 1, charBeforeCursor, closeBrackets[charBeforeCursor]);
    if (match !== -1) {
      const matchLines = text.substring(0, match).split('\n');
      const matchLine = matchLines.length;
      const matchCol = matchLines[matchLines.length - 1].length + 1;
      info += ` — <span class="bracket-match">Closing ${charBeforeCursor} matches opening at Ln ${matchLine}, Col ${matchCol}</span>`;
    } else {
      info += ` — <span class="bracket-error">No matching ${closeBrackets[charBeforeCursor]} found</span>`;
    }
  } else if (charAtCursor && closeBrackets[charAtCursor]) {
    // On a closing bracket
    const match = findMatchingOpen(text, pos, charAtCursor, closeBrackets[charAtCursor]);
    if (match !== -1) {
      const matchLines = text.substring(0, match).split('\n');
      const matchLine = matchLines.length;
      const matchCol = matchLines[matchLines.length - 1].length + 1;
      info += ` — <span class="bracket-match">Closing ${charAtCursor} matches opening at Ln ${matchLine}, Col ${matchCol}</span>`;
    } else {
      info += ` — <span class="bracket-error">No matching ${closeBrackets[charAtCursor]} found</span>`;
    }
  } else {
    // Show nesting depth
    const depth = getBracketDepth(text, pos);
    info += ` — <span>Depth: ${depth.objects} objects, ${depth.arrays} arrays</span>`;
  }

  statusEl.innerHTML = info;
}

function findMatchingClose(text, startPos, openChar, closeChar) {
  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = startPos; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === openChar) depth++;
    if (ch === closeChar) { depth--; if (depth === 0) return i; }
  }
  return -1;
}

function findMatchingOpen(text, startPos, closeChar, openChar) {
  let depth = 0;
  let inString = false;

  for (let i = startPos; i >= 0; i--) {
    const ch = text[i];
    // Simplified string detection (not perfect for reverse traversal but good enough)
    if (ch === '"' && (i === 0 || text[i-1] !== '\\')) { inString = !inString; continue; }
    if (inString) continue;
    if (ch === closeChar) depth++;
    if (ch === openChar) { depth--; if (depth === 0) return i; }
  }
  return -1;
}

function getBracketDepth(text, pos) {
  let objects = 0;
  let arrays = 0;
  let inString = false;
  let escape = false;

  for (let i = 0; i < pos; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') objects++;
    if (ch === '}') objects--;
    if (ch === '[') arrays++;
    if (ch === ']') arrays--;
  }
  return { objects, arrays };
}

// ---- Export / Import ----
async function exportConfig() {
  try {
    const res = await fetch(`${API_BASE}/export`);
    const data = await res.json();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `orchestrator-config-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (err) {
    alert('Export failed: ' + err.message);
  }
}

async function importConfig(event) {
  const file = event.target.files[0];
  if (!file) return;

  const mode = confirm('Replace all existing configuration?\n\nOK = Replace everything\nCancel = Merge (add/update without deleting existing)')
    ? 'replace' : 'merge';

  try {
    const text = await file.text();
    const config = JSON.parse(text);

    const res = await fetch(`${API_BASE}/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...config, mode }),
    });
    const result = await res.json();
    alert(`${result.message}\n\nBackends: ${result.imported.backends}\nRoutes: ${result.imported.routes}\nDatabases: ${result.imported.databases}\nMocks: ${result.imported.mocks || 0}`);

    // Reload all data
    loadBackends();
    loadRoutes();
    loadDatabases();
    loadMocks();
  } catch (err) {
    alert('Import failed: ' + err.message);
  }

  // Reset file input
  event.target.value = '';
}

// ---- Utils ----
function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Make functions global for onclick handlers
window.openBackendEditor = openBackendEditor;
window.deleteBackend = deleteBackend;
window.viewBackend = viewBackend;
window.openRouteEditor = openRouteEditor;
window.deleteRoute = deleteRoute;
window.viewRoute = viewRoute;
window.openDatabaseEditor = openDatabaseEditor;
window.deleteDatabase = deleteDatabase;
window.viewDatabase = viewDatabase;
window.viewAuditEntry = viewAuditEntry;
window.rollbackAudit = rollbackAudit;
window.viewLogEntry = viewLogEntry;
window.viewMock = viewMock;
window.editMock = editMock;
window.toggleMock = toggleMock;
window.deleteMock = deleteMock;

// ---- Event Targets ----
async function loadEventTargets() {
  try {
    const res = await fetch(`${API_BASE}/event-targets`);
    const data = await res.json();
    eventTargets = data.eventTargets || [];
    renderEventTargets();
  } catch (err) {
    console.error('Failed to load event targets:', err);
  }
}

const IMPLEMENTED_TARGET_TYPES = ['webhook', 'sns', 'sqs', 'eventbridge'];

function renderEventTargets() {
  const container = document.getElementById('event-targets-list');
  if (eventTargets.length === 0) {
    container.innerHTML = '<p style="color: var(--text-muted); padding: 20px;">No event targets configured. Click "Add Event Target" to get started.</p>';
    return;
  }
  container.innerHTML = eventTargets.map((t) => {
    const notImpl = !IMPLEMENTED_TARGET_TYPES.includes(t.type);
    return `
    <div class="card" data-id="${t.id}">
      <div class="card-info">
        <h4>${escapeHtml(t.name)} <span class="badge badge-auth">${escapeHtml(t.type)}</span>${notImpl ? ' <span class="badge badge-auth" style="color: var(--danger);">not implemented</span>' : ''}</h4>
        <p>${escapeHtml(JSON.stringify(t.config || {}).slice(0, 100))}</p>
      </div>
      <div class="card-actions">
        <button class="btn btn-secondary btn-sm" onclick="openEventTargetEditor('${t.id}')">Edit</button>
        <button class="btn btn-danger btn-sm" onclick="deleteEventTarget('${t.id}')">Delete</button>
      </div>
    </div>`;
  }).join('');
}

const EVENT_TARGET_CONFIG_TEMPLATES = {
  'webhook': { url: 'https://example.com/webhook', headers: {}, timeoutMs: 10000 },
  'sns': { topicArn: 'arn:aws:sns:us-east-1:123456789012:my-topic', region: 'us-east-1' },
  'sqs': { queueUrl: 'https://sqs.us-east-1.amazonaws.com/123456789012/my-queue', region: 'us-east-1' },
  'eventbridge': { eventBusName: 'default', source: 'my.app', detailType: 'OrchestrationCompleted', region: 'us-east-1' },
  'kafka': { brokers: ['localhost:9092'], topic: 'events' },
  'rabbitmq': { url: 'amqp://localhost', queue: 'events' },
  'azure-servicebus': { connectionString: '', queueOrTopic: 'events' },
  'gcp-pubsub': { projectId: '', topic: 'events' },
};

function createNewEventTarget(type) {
  const template = {
    name: 'My Event Target',
    type,
    config: EVENT_TARGET_CONFIG_TEMPLATES[type] || {},
  };
  openModal(
    'New Event Target',
    JSON.stringify(template, null, 2),
    async (json) => {
      const target = JSON.parse(json);
      await fetch(`${API_BASE}/event-targets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(target),
      });
      await loadEventTargets();
    }
  );
}

function openEventTargetEditor(id) {
  const existing = eventTargets.find((t) => t.id === id);
  if (!existing) return;
  openModal(
    `Edit Event Target: ${existing.name}`,
    JSON.stringify(existing, null, 2),
    async (json) => {
      const target = JSON.parse(json);
      await fetch(`${API_BASE}/event-targets/${target.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(target),
      });
      await loadEventTargets();
    }
  );
}

async function deleteEventTarget(id) {
  if (!confirm('Delete this event target? Routes referencing it will fail to publish.')) return;
  await fetch(`${API_BASE}/event-targets/${id}`, { method: 'DELETE' });
  await loadEventTargets();
}

// ---- Events ----
async function loadEvents() {
  try {
    const params = new URLSearchParams({ limit: '200' });
    if (eventsStatusFilter) params.set('status', eventsStatusFilter);
    const res = await fetch(`${API_BASE}/events?${params}`);
    const data = await res.json();
    renderEvents(data.events || []);
  } catch (err) {
    console.error('Failed to load events:', err);
  }
}

function eventStatusClass(status) {
  switch (status) {
    case 'DELIVERED': return '2xx';
    case 'DELIVERY_FAILED':
    case 'TIMED_OUT': return '5xx';
    default: return '4xx';
  }
}

function renderEvents(events) {
  const container = document.getElementById('events-list');
  if (events.length === 0) {
    container.innerHTML = '<p style="color: var(--text-muted); padding: 20px;">No events yet. Trigger an event-enabled route to see events here.</p>';
    return;
  }
  container.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Time</th>
          <th>Route</th>
          <th>Target</th>
          <th>Status</th>
          <th>Attempts</th>
          <th>Last Error</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        ${events.map((e) => {
          const canRestart = e.status === 'TIMED_OUT';
          const canRepublish = e.status === 'DELIVERY_FAILED' || e.status === 'DELIVERED';
          return `
          <tr>
            <td>${new Date(e.createdAt).toLocaleString()}</td>
            <td>${escapeHtml(e.routeName || e.routeId)}</td>
            <td>${escapeHtml(e.targetType || '')}</td>
            <td><span class="status-badge status-${eventStatusClass(e.status)}">${e.status}</span></td>
            <td>${e.attempts || 0}</td>
            <td>${e.lastError ? escapeHtml(String(e.lastError).slice(0, 50)) : '—'}</td>
            <td>
              <button class="btn btn-secondary btn-sm" onclick="viewEvent(${e.id})">View</button>
              ${canRestart ? `<button class="btn btn-secondary btn-sm" onclick="restartEvent(${e.id})">Restart</button>` : ''}
              ${canRepublish ? `<button class="btn btn-secondary btn-sm" onclick="republishEvent(${e.id})">Re-publish</button>` : ''}
            </td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>
  `;
}

async function viewEvent(id) {
  try {
    const res = await fetch(`${API_BASE}/events/${id}`);
    const event = await res.json();
    openModalReadOnly(`Event #${event.id}: ${event.routeName || event.routeId}`, JSON.stringify(event, null, 2));
  } catch (err) {
    alert('Failed to load event: ' + err.message);
  }
}

async function restartEvent(id) {
  if (!confirm('Restart this timed-out event? Readiness polling will resume.')) return;
  try {
    const res = await fetch(`${API_BASE}/events/${id}/restart`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) { alert(data.error); return; }
    loadEvents();
  } catch (err) {
    alert('Restart failed: ' + err.message);
  }
}

async function republishEvent(id) {
  if (!confirm('Re-publish this event? It will be re-queued for delivery.')) return;
  try {
    const res = await fetch(`${API_BASE}/events/${id}/republish`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) { alert(data.error); return; }
    loadEvents();
  } catch (err) {
    alert('Re-publish failed: ' + err.message);
  }
}

window.openEventTargetEditor = openEventTargetEditor;
window.deleteEventTarget = deleteEventTarget;
window.viewEvent = viewEvent;
window.restartEvent = restartEvent;
window.republishEvent = republishEvent;

// ---- Received Webhooks ----
async function loadReceivedWebhooks() {
  try {
    const res = await fetch(`${API_BASE}/received-webhooks?limit=200`);
    const data = await res.json();
    renderReceivedWebhooks(data.webhooks || []);
  } catch (err) {
    console.error('Failed to load received webhooks:', err);
  }
}

function renderReceivedWebhooks(webhooks) {
  const container = document.getElementById('received-webhooks-list');
  if (webhooks.length === 0) {
    container.innerHTML = '<p style="color: var(--text-muted); padding: 20px;">No webhooks received yet. Send a POST to /webhooks/&lt;name&gt; to see it here.</p>';
    return;
  }
  container.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Time</th>
          <th>Name</th>
          <th>Method</th>
          <th>Body Preview</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        ${webhooks.map((w) => {
          let preview = '';
          try { preview = JSON.stringify(w.body).slice(0, 60); } catch { preview = String(w.body).slice(0, 60); }
          return `
          <tr>
            <td>${new Date(w.receivedAt).toLocaleString()}</td>
            <td>${escapeHtml(w.name)}</td>
            <td>${escapeHtml(w.method)}</td>
            <td>${escapeHtml(preview)}</td>
            <td><button class="btn btn-secondary btn-sm" onclick="viewReceivedWebhook(${w.id})">View</button></td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>
  `;
}

async function viewReceivedWebhook(id) {
  try {
    const res = await fetch(`${API_BASE}/received-webhooks/${id}`);
    const wh = await res.json();
    openModalReadOnly(`Received Webhook #${wh.id}: ${wh.name}`, JSON.stringify(wh, null, 2));
  } catch (err) {
    alert('Failed to load webhook: ' + err.message);
  }
}

async function clearReceivedWebhooks() {
  if (!confirm('Clear all received webhooks?')) return;
  try {
    await fetch(`${API_BASE}/received-webhooks`, { method: 'DELETE' });
    loadReceivedWebhooks();
  } catch (err) {
    alert('Failed to clear: ' + err.message);
  }
}

window.viewReceivedWebhook = viewReceivedWebhook;


// ---- Performance ----
let perfChart = null;
let perfSelectedRoutes = new Set(); // empty = all selected
let perfTimeFrom = '';
let perfTimeTo = '';

function getDefaultPerfFrom() {
  const d = new Date(Date.now() - 10 * 60 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function loadPerformance() {
  // Set default from if not already set
  if (!perfTimeFrom) {
    perfTimeFrom = getDefaultPerfFrom();
    document.getElementById('perf-from').value = perfTimeFrom;
  }
  await loadPerfChart();
  await loadPerfTable();
}

function getPerfTimeParams() {
  let params = '';
  if (perfTimeFrom) params += `&from=${encodeURIComponent(new Date(perfTimeFrom).toISOString())}`;
  if (perfTimeTo) params += `&to=${encodeURIComponent(new Date(perfTimeTo).toISOString())}`;
  return params;
}

function applyPerfTimeFilter() {
  perfTimeFrom = document.getElementById('perf-from').value;
  perfTimeTo = document.getElementById('perf-to').value;
  loadPerformance();
}

function resetPerfTimeFilter() {
  perfTimeFrom = getDefaultPerfFrom();
  perfTimeTo = '';
  document.getElementById('perf-from').value = perfTimeFrom;
  document.getElementById('perf-to').value = '';
  loadPerformance();
}

async function loadPerfChart() {
  try {
    const routeParam = perfSelectedRoutes.size > 0 ? `routes=${Array.from(perfSelectedRoutes).join(',')}` : '';
    const timeParams = getPerfTimeParams();
    const queryStr = [routeParam, timeParams.replace(/^&/, '')].filter(Boolean).join('&');
    const res = await fetch(`${API_BASE}/performance/timeseries${queryStr ? '?' + queryStr : ''}`);
    const data = await res.json();
    const timeseries = data.timeseries || [];
    const routes = data.routes || [];

    // Build filter checkboxes (moved to table)
    const ctx = document.getElementById('perf-chart').getContext('2d');

    if (perfChart) {
      perfChart.destroy();
    }

    const labels = timeseries.map(t => {
      const d = new Date(t.time);
      return d.toLocaleTimeString();
    });

    perfChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: 'Mean Response Time (ms)',
            data: timeseries.map(t => t.meanResponseTime),
            borderColor: '#58a6ff',
            backgroundColor: 'rgba(88, 166, 255, 0.1)',
            yAxisID: 'y',
            tension: 0.3,
            fill: true,
          },
          {
            label: 'Overhead (ms)',
            data: timeseries.map(t => t.meanOverhead),
            borderColor: '#f85149',
            backgroundColor: 'rgba(248, 81, 73, 0.1)',
            yAxisID: 'y',
            tension: 0.3,
            fill: true,
            borderDash: [3, 3],
          },
          {
            label: 'Concurrent Requests',
            data: timeseries.map(t => t.concurrency),
            borderColor: '#d29922',
            backgroundColor: 'rgba(210, 153, 34, 0.1)',
            yAxisID: 'y1',
            tension: 0.3,
            fill: true,
          },
          {
            label: 'Calls/sec',
            data: timeseries.map(t => t.callsPerSecond),
            borderColor: '#3fb950',
            backgroundColor: 'rgba(63, 185, 80, 0.05)',
            yAxisID: 'y1',
            tension: 0.3,
            fill: false,
            borderDash: [5, 5],
          }
        ]
      },
      options: {
        responsive: true,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { labels: { color: '#8b949e' } }
        },
        scales: {
          x: {
            ticks: { color: '#8b949e', maxTicksLimit: 20 },
            grid: { color: 'rgba(45, 58, 69, 0.5)' }
          },
          y: {
            type: 'linear',
            display: true,
            position: 'left',
            title: { display: true, text: 'Response Time (ms)', color: '#58a6ff' },
            ticks: { color: '#58a6ff' },
            grid: { color: 'rgba(45, 58, 69, 0.5)' }
          },
          y1: {
            type: 'linear',
            display: true,
            position: 'right',
            title: { display: true, text: 'Concurrency / Calls per sec', color: '#d29922' },
            ticks: { color: '#d29922' },
            grid: { drawOnChartArea: false }
          }
        }
      }
    });
  } catch (err) {
    console.error('Failed to load chart:', err);
  }
}

let perfStats = [];
let perfSortCol = 'callCount';
let perfSortDir = 'desc';

async function loadPerfTable() {
  const container = document.getElementById('performance-content');
  try {
    const timeParams = getPerfTimeParams();
    const res = await fetch(`${API_BASE}/performance${timeParams ? '?' + timeParams.replace(/^&/, '') : ''}`);
    const data = await res.json();
    perfStats = data.performance || [];

    if (perfStats.length === 0) {
      container.innerHTML = '<p style="color: var(--text-muted); padding: 20px;">No performance data yet. Execute some API calls first.</p>';
      return;
    }

    renderPerfTable();
  } catch (err) {
    container.innerHTML = '<p style="color: var(--danger);">Failed to load performance data.</p>';
  }
}

function renderPerfTable() {
    const container = document.getElementById('performance-content');
    const stats = [...perfStats];

    // Sort
    stats.sort((a, b) => {
      let aVal, bVal;
      switch (perfSortCol) {
        case 'route': aVal = a.routeName; bVal = b.routeName; break;
        case 'callCount': aVal = a.callCount; bVal = b.callCount; break;
        case 'successCount': aVal = a.successCount; bVal = b.successCount; break;
        case 'failureCount': aVal = a.failureCount; bVal = b.failureCount; break;
        case 'mean': aVal = a.all.mean; bVal = b.all.mean; break;
        case 'min': aVal = a.all.min; bVal = b.all.min; break;
        case 'max': aVal = a.all.max; bVal = b.all.max; break;
        case 'overhead': aVal = a.overhead.mean; bVal = b.overhead.mean; break;
        default: aVal = a.callCount; bVal = b.callCount;
      }
      if (typeof aVal === 'string') {
        const cmp = aVal.localeCompare(bVal);
        return perfSortDir === 'asc' ? cmp : -cmp;
      }
      return perfSortDir === 'asc' ? aVal - bVal : bVal - aVal;
    });

    const sortIcon = (col) => perfSortCol === col ? (perfSortDir === 'asc' ? ' ▲' : ' ▼') : '';
    const sortStyle = 'cursor: pointer; user-select: none;';

    let html = '<table class="perf-table"><thead><tr>';
    html += '<th><input type="checkbox" id="perf-select-all" checked onchange="togglePerfAll(this.checked)"></th>';
    html += `<th style="${sortStyle}" onclick="sortPerfTable('route')">Route${sortIcon('route')}</th>`;
    html += `<th style="${sortStyle}" onclick="sortPerfTable('callCount')">Total${sortIcon('callCount')}</th>`;
    html += `<th style="${sortStyle}" onclick="sortPerfTable('successCount')">Success${sortIcon('successCount')}</th>`;
    html += `<th style="${sortStyle}" onclick="sortPerfTable('failureCount')">Failed${sortIcon('failureCount')}</th>`;
    html += `<th style="${sortStyle}" onclick="sortPerfTable('mean')">Mean (ms)${sortIcon('mean')}</th>`;
    html += `<th style="${sortStyle}" onclick="sortPerfTable('min')">Min${sortIcon('min')}</th>`;
    html += `<th style="${sortStyle}" onclick="sortPerfTable('max')">Max${sortIcon('max')}</th>`;
    html += `<th style="${sortStyle}" onclick="sortPerfTable('overhead')">Overhead${sortIcon('overhead')}</th>`;
    html += '<th>View</th>';
    html += '</tr></thead><tbody>';

    stats.forEach((stat, idx) => {
      const failRate = stat.callCount > 0 ? Math.round((stat.failureCount / stat.callCount) * 100) : 0;
      const checked = perfSelectedRoutes.size === 0 || perfSelectedRoutes.has(stat.routeId) ? 'checked' : '';
      html += `<tr>`;
      html += `<td><input type="checkbox" ${checked} onchange="togglePerfRoute('${stat.routeId}')"></td>`;
      html += `<td><strong>${escapeHtml(stat.routeName)}</strong></td>`;
      html += `<td>${stat.callCount}</td>`;
      html += `<td style="color: var(--success);">${stat.successCount}</td>`;
      html += `<td style="color: ${stat.failureCount > 0 ? 'var(--danger)' : 'var(--text-muted)'};">${stat.failureCount}${failRate > 0 ? ` (${failRate}%)` : ''}</td>`;
      html += `<td>${stat.all.mean} ±${stat.all.stdDev}</td>`;
      html += `<td>${stat.all.min}</td>`;
      html += `<td>${stat.all.max}</td>`;
      html += `<td>${stat.overhead.mean} ±${stat.overhead.stdDev}</td>`;
      html += `<td><button class="btn btn-secondary btn-sm" onclick="togglePerfDetail(${idx})">Details</button> <button class="btn btn-secondary btn-sm" onclick="viewLogsForRoute('${stat.routeId}')">Logs</button></td>`;
      html += `</tr>`;

      // Expandable detail row
      html += `<tr id="perf-detail-${idx}" style="display: none;"><td colspan="10" style="padding: 16px;">`;

      // Success/Failure/All summary
      html += '<h4 style="margin: 0 0 8px; color: var(--text-muted);">Response Time Breakdown</h4>';
      html += '<table style="width: 100%; margin-bottom: 16px;"><thead><tr><th>Category</th><th>Count</th><th>Mean (ms)</th><th>Min</th><th>Max</th></tr></thead><tbody>';
      html += `<tr><td>All</td><td>${stat.all.count}</td><td>${stat.all.mean} ±${stat.all.stdDev}</td><td>${stat.all.min}</td><td>${stat.all.max}</td></tr>`;
      html += `<tr><td style="color: var(--success);">Success (2xx/3xx)</td><td>${stat.success.count}</td><td>${stat.success.mean} ±${stat.success.stdDev}</td><td>${stat.success.min}</td><td>${stat.success.max}</td></tr>`;
      html += `<tr><td style="color: var(--danger);">Failed (4xx/5xx)</td><td>${stat.failure.count}</td><td>${stat.failure.mean} ±${stat.failure.stdDev}</td><td>${stat.failure.min}</td><td>${stat.failure.max}</td></tr>`;
      html += '</tbody></table>';

      // Per-step breakdown
      html += '<h4 style="margin: 0 0 8px; color: var(--text-muted);">Per-Step Breakdown</h4>';
      html += '<table style="width: 100%;"><thead><tr><th>Step</th><th>Category</th><th>Count</th><th>Mean (ms)</th><th>Min</th><th>Max</th></tr></thead><tbody>';
      for (const [stepId, stepStat] of Object.entries(stat.steps)) {
        html += `<tr><td rowspan="3"><strong>${escapeHtml(stepId)}</strong></td><td>All</td><td>${stepStat.all.count}</td><td>${stepStat.all.mean} ±${stepStat.all.stdDev}</td><td>${stepStat.all.min}</td><td>${stepStat.all.max}</td></tr>`;
        html += `<tr><td style="color: var(--success);">Success</td><td>${stepStat.success.count}</td><td>${stepStat.success.mean} ±${stepStat.success.stdDev}</td><td>${stepStat.success.min}</td><td>${stepStat.success.max}</td></tr>`;
        html += `<tr><td style="color: var(--danger);">Failed</td><td>${stepStat.failure.count}</td><td>${stepStat.failure.mean} ±${stepStat.failure.stdDev}</td><td>${stepStat.failure.min}</td><td>${stepStat.failure.max}</td></tr>`;
      }
      html += '</tbody></table>';
      html += '</td></tr>';
    });

    html += '</tbody></table>';
    container.innerHTML = html;
}

function sortPerfTable(col) {
  if (perfSortCol === col) {
    perfSortDir = perfSortDir === 'asc' ? 'desc' : 'asc';
  } else {
    perfSortCol = col;
    perfSortDir = 'desc';
  }
  renderPerfTable();
}

function togglePerfDetail(idx) {
  const row = document.getElementById(`perf-detail-${idx}`);
  if (row) {
    row.style.display = row.style.display === 'none' ? '' : 'none';
  }
}

function viewLogsForRoute(routeId) {
  logsRouteFilter = routeId;
  logsPage = 1;
  // Switch to logs tab
  const logsBtn = document.querySelector('.nav-btn[data-tab="logs"]');
  if (logsBtn) logsBtn.click();
  // Reset and reload
  const select = document.getElementById('logs-route-filter');
  select.innerHTML = '<option value="">All Routes</option>';
  loadLogs();
}

function togglePerfRoute(routeId) {
  // If set is empty (all selected), initialize with all routes minus the unchecked one
  if (perfSelectedRoutes.size === 0) {
    perfStats.forEach(s => { if (s.routeId !== routeId) perfSelectedRoutes.add(s.routeId); });
  } else if (perfSelectedRoutes.has(routeId)) {
    perfSelectedRoutes.delete(routeId);
  } else {
    perfSelectedRoutes.add(routeId);
  }
  // If all are selected again, clear the set (means "all")
  if (perfSelectedRoutes.size === perfStats.length) {
    perfSelectedRoutes.clear();
  }
  loadPerfChart();
}

function togglePerfAll(checked) {
  const checkboxes = document.querySelectorAll('.perf-table input[type="checkbox"]:not(#perf-select-all)');
  checkboxes.forEach(cb => { cb.checked = checked; });
  perfSelectedRoutes.clear();
  loadPerfChart();
}

// ---- Performance CSV Export ----
function downloadCSV(filename, csvContent) {
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

function escapeCSV(val) {
  if (val === null || val === undefined) return '';
  const str = String(val);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

function exportPerfSummaryCSV() {
  if (!perfStats || perfStats.length === 0) {
    alert('No performance data to export. Refresh the performance tab first.');
    return;
  }

  const headers = [
    'Route', 'Total Calls', 'Success', 'Failed', 'Fail %',
    'Mean (ms)', 'Std Dev', 'Min', 'Max',
    'Success Mean', 'Success Std Dev', 'Success Min', 'Success Max',
    'Failure Mean', 'Failure Std Dev', 'Failure Min', 'Failure Max',
    'Overhead Mean', 'Overhead Std Dev', 'Overhead Min', 'Overhead Max'
  ];

  const rows = perfStats.map(stat => {
    const failRate = stat.callCount > 0 ? Math.round((stat.failureCount / stat.callCount) * 100) : 0;
    return [
      stat.routeName,
      stat.callCount,
      stat.successCount,
      stat.failureCount,
      failRate + '%',
      stat.all.mean, stat.all.stdDev, stat.all.min, stat.all.max,
      stat.success.mean, stat.success.stdDev, stat.success.min, stat.success.max,
      stat.failure.mean, stat.failure.stdDev, stat.failure.min, stat.failure.max,
      stat.overhead.mean, stat.overhead.stdDev, stat.overhead.min, stat.overhead.max
    ];
  });

  const csv = [headers.map(escapeCSV).join(','), ...rows.map(r => r.map(escapeCSV).join(','))].join('\n');
  const suffix = perfTimeFrom || perfTimeTo ? `_${perfTimeFrom || 'start'}_to_${perfTimeTo || 'now'}` : '';
  downloadCSV(`performance-summary-${new Date().toISOString().slice(0, 10)}${suffix}.csv`, csv);
}

function exportPerfDetailCSV() {
  if (!perfStats || perfStats.length === 0) {
    alert('No performance data to export. Refresh the performance tab first.');
    return;
  }

  const headers = [
    'Route', 'Step', 'Category',
    'Count', 'Mean (ms)', 'Std Dev', 'Min', 'Max'
  ];

  const rows = [];
  for (const stat of perfStats) {
    // Route-level rows
    rows.push([stat.routeName, '(total)', 'All', stat.all.count, stat.all.mean, stat.all.stdDev, stat.all.min, stat.all.max]);
    rows.push([stat.routeName, '(total)', 'Success', stat.success.count, stat.success.mean, stat.success.stdDev, stat.success.min, stat.success.max]);
    rows.push([stat.routeName, '(total)', 'Failed', stat.failure.count, stat.failure.mean, stat.failure.stdDev, stat.failure.min, stat.failure.max]);
    rows.push([stat.routeName, '(overhead)', 'All', stat.overhead.count, stat.overhead.mean, stat.overhead.stdDev, stat.overhead.min, stat.overhead.max]);

    // Per-step rows
    for (const [stepId, stepStat] of Object.entries(stat.steps)) {
      rows.push([stat.routeName, stepId, 'All', stepStat.all.count, stepStat.all.mean, stepStat.all.stdDev, stepStat.all.min, stepStat.all.max]);
      rows.push([stat.routeName, stepId, 'Success', stepStat.success.count, stepStat.success.mean, stepStat.success.stdDev, stepStat.success.min, stepStat.success.max]);
      rows.push([stat.routeName, stepId, 'Failed', stepStat.failure.count, stepStat.failure.mean, stepStat.failure.stdDev, stepStat.failure.min, stepStat.failure.max]);
    }
  }

  const csv = [headers.map(escapeCSV).join(','), ...rows.map(r => r.map(escapeCSV).join(','))].join('\n');
  const suffix = perfTimeFrom || perfTimeTo ? `_${perfTimeFrom || 'start'}_to_${perfTimeTo || 'now'}` : '';
  downloadCSV(`performance-detail-${new Date().toISOString().slice(0, 10)}${suffix}.csv`, csv);
}


// ---- Documentation ----
async function loadDocsIndex() {
  const container = document.getElementById('docs-results');
  try {
    const res = await fetch(`${API_BASE}/docs/search?q=`);
    const data = await res.json();

    if (!data.results || data.results.length === 0) {
      container.innerHTML = '<p style="color: var(--text-muted); padding: 20px;">No documentation found.</p>';
      return;
    }

    container.innerHTML = `
      <div class="card-list">
        ${data.results.map((doc) => `
          <div class="card" style="cursor: pointer;" onclick="viewDoc('${doc.file}')">
            <div class="card-info">
              <h4>${escapeHtml(doc.title)}</h4>
              <p>${escapeHtml(doc.file)}</p>
            </div>
            <div class="card-actions">
              <button class="btn btn-secondary btn-sm" onclick="event.stopPropagation(); viewDoc('${doc.file}')">View</button>
            </div>
          </div>
        `).join('')}
      </div>
    `;
  } catch (err) {
    container.innerHTML = '<p style="color: var(--danger);">Failed to load documentation.</p>';
  }
}

async function viewDoc(filename) {
  const container = document.getElementById('docs-results');
  try {
    const res = await fetch(`${API_BASE}/docs/${filename}`);
    const data = await res.json();

    container.innerHTML = `
      <div style="margin-bottom: 16px;">
        <button class="btn btn-secondary btn-sm" onclick="loadDocsIndex()">← Back to docs</button>
      </div>
      <div class="docs-content">${formatMarkdown(data.content)}</div>
    `;
  } catch (err) {
    container.innerHTML = '<p style="color: var(--danger);">Failed to load document.</p>';
  }
}

async function searchDocs(query) {
  if (!query) {
    loadDocsIndex();
    return;
  }
  const container = document.getElementById('docs-results');
  try {
    const res = await fetch(`${API_BASE}/docs/search?q=${encodeURIComponent(query)}`);
    const data = await res.json();

    if (!data.results || data.results.length === 0) {
      container.innerHTML = '<p style="color: var(--text-muted); padding: 20px;">No results found.</p>';
      return;
    }

    container.innerHTML = data.results.map((doc) => {
      const matchesHtml = doc.matches.map((m) => {
        const highlighted = m.text.replace(new RegExp(`(${escapeRegex(query)})`, 'gi'), '<mark>$1</mark>');
        return `<div class="doc-match"><span class="doc-line">Line ${m.line}</span><pre>${highlighted}</pre></div>`;
      }).join('');
      return `
        <div class="doc-section">
          <h3 class="doc-title" style="cursor: pointer;" onclick="viewDoc('${doc.file}')">${escapeHtml(doc.title)}</h3>
          ${matchesHtml}
        </div>
      `;
    }).join('<hr>');
  } catch (err) {
    container.innerHTML = '<p style="color: var(--danger);">Failed to load documentation.</p>';
  }
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function formatMarkdown(text) {
  // Split into lines and process blocks
  const lines = text.split(/\r?\n/);
  let html = '';
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Code blocks
    if (line.startsWith('```')) {
      let code = '';
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        code += lines[i] + '\n';
        i++;
      }
      i++; // skip closing ```
      html += `<pre><code>${code}</code></pre>`;
      continue;
    }

    // Table block
    if (line.trim().startsWith('|') && line.trim().endsWith('|')) {
      let tableRows = [];
      while (i < lines.length && lines[i].trim().startsWith('|') && lines[i].trim().endsWith('|')) {
        const cells = lines[i].trim().split('|').slice(1, -1);
        // Skip separator rows
        if (!cells.every(c => c.trim().match(/^[-:]+$/))) {
          tableRows.push(cells.map(c => c.trim()));
        }
        i++;
      }
      if (tableRows.length > 0) {
        html += '<table>';
        html += '<tr>' + tableRows[0].map(c => `<th>${formatInline(c)}</th>`).join('') + '</tr>';
        for (let r = 1; r < tableRows.length; r++) {
          html += '<tr>' + tableRows[r].map(c => `<td>${formatInline(c)}</td>`).join('') + '</tr>';
        }
        html += '</table>';
      }
      continue;
    }

    // Headers
    if (line.startsWith('### ')) { html += `<h4>${formatInline(line.slice(4))}</h4>`; i++; continue; }
    if (line.startsWith('## ')) { html += `<h3>${formatInline(line.slice(3))}</h3>`; i++; continue; }
    if (line.startsWith('# ')) { html += `<h2>${formatInline(line.slice(2))}</h2>`; i++; continue; }

    // Images
    const imgMatch = line.trim().match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
    if (imgMatch) { html += `<img src="${imgMatch[2]}" alt="${imgMatch[1]}" style="max-width: 100%; border-radius: 8px; margin: 16px 0;">`; i++; continue; }

    // Horizontal rule
    if (line.trim() === '---') { html += '<hr>'; i++; continue; }

    // Unordered list
    if (line.startsWith('- ')) {
      html += '<ul>';
      while (i < lines.length && lines[i].startsWith('- ')) {
        html += `<li>${formatInline(lines[i].slice(2))}</li>`;
        i++;
      }
      html += '</ul>';
      continue;
    }

    // Empty line = paragraph break
    if (line.trim() === '') { html += '<br>'; i++; continue; }

    // Regular text
    html += `<p>${formatInline(line)}</p>`;
    i++;
  }

  return html;
}

function formatInline(text) {
  return text
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}


// ---- Session heartbeat ----
// Keep session alive while an edit modal is open (prevents losing unsaved work)
setInterval(() => {
  const modal = document.getElementById('modal');
  if (modal && !modal.classList.contains('hidden') && modalSaveCallback) {
    fetch('/admin/backends').catch(() => {});
  }
}, 5 * 60 * 1000); // Every 5 minutes

// ---- Session check ----
// Intercept all fetch calls — if we get a 401, redirect to login
const originalFetch = window.fetch;
window.fetch = async function(...args) {
  const response = await originalFetch.apply(this, args);
  if (response.status === 401) {
    window.location.href = '/ui/login.html';
  }
  return response;
};
