// ============================================================
// API Orchestrator - Web UI
// ============================================================

const API_BASE = '/admin';

// ---- State ----
let backends = [];
let routes = [];
let databases = [];
let mocks = [];

// ---- Init ----
document.addEventListener('DOMContentLoaded', () => {
  setupTabs();
  setupModal();
  setupTest();
  loadBackends();
  loadRoutes();
  loadDatabases();
  loadMocks();

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
  document.getElementById('refresh-audit-btn').addEventListener('click', loadAudit);
  document.getElementById('clear-audit-btn').addEventListener('click', clearAudit);
  document.getElementById('audit-filter-type').addEventListener('change', loadAudit);
  document.getElementById('export-btn').addEventListener('click', exportConfig);
  document.getElementById('import-btn').addEventListener('click', () => document.getElementById('import-file').click());
  document.getElementById('import-file').addEventListener('change', importConfig);
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

      // Load data on tab switch
      if (btn.dataset.tab === 'logs') loadLogs();
      if (btn.dataset.tab === 'audit') loadAudit();
      if (btn.dataset.tab === 'docs') searchDocs('');
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

function renderRoutes() {
  const container = document.getElementById('routes-list');
  if (routes.length === 0) {
    container.innerHTML = '<p style="color: var(--text-muted); padding: 20px;">No routes configured. Click "Add Route" to create an orchestration.</p>';
    return;
  }

  container.innerHTML = routes.map((r) => `
    <div class="card" data-id="${r.id}">
      <div class="card-info">
        <h4>
          <span class="badge badge-method">${r.method}</span>
          ${escapeHtml(r.path)}
          — ${escapeHtml(r.name)}
        </h4>
        <p>${r.steps?.length || 0} steps • ${r.description ? escapeHtml(r.description.slice(0, 80)) : 'No description'}</p>
      </div>
      <div class="card-actions">
        <button class="btn btn-secondary btn-sm" onclick="viewRoute('${r.id}')">View</button>
        <button class="btn btn-secondary btn-sm" onclick="openRouteEditor('${r.id}')">Edit</button>
        <button class="btn btn-danger btn-sm" onclick="deleteRoute('${r.id}')">Delete</button>
      </div>
    </div>
  `).join('');
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
async function loadLogs() {
  try {
    const res = await fetch(`${API_BASE}/logs?limit=50`);
    const data = await res.json();
    renderLogs(data.logs || []);
  } catch (err) {
    console.error('Failed to load logs:', err);
  }
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

function renderLogs(logs) {
  const container = document.getElementById('logs-list');
  if (logs.length === 0) {
    container.innerHTML = '<p style="color: var(--text-muted); padding: 20px;">No execution logs yet. Send a request to /api/* to see logs here.</p>';
    return;
  }

  container.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Time</th>
          <th>Route</th>
          <th>Method</th>
          <th>Path</th>
          <th>Status</th>
          <th>Duration</th>
          <th>Error</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        ${logs.map((log) => `
          <tr>
            <td>${new Date(log.created_at).toLocaleString()}</td>
            <td>${escapeHtml(log.route_name || '')}</td>
            <td>${log.inbound_method}</td>
            <td>${escapeHtml(log.inbound_path)}</td>
            <td><span class="status-badge status-${statusClass(log.status_code)}">${log.status_code}</span></td>
            <td>${log.duration_ms}ms</td>
            <td>${log.error ? escapeHtml(log.error.slice(0, 50)) : '—'}</td>
            <td><button class="btn btn-secondary btn-sm" onclick="viewLogEntry(${log.id})">View</button></td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
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


// ---- Documentation ----
async function searchDocs(query) {
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
        const highlighted = query
          ? m.text.replace(new RegExp(`(${escapeRegex(query)})`, 'gi'), '<mark>$1</mark>')
          : formatMarkdown(m.text);
        return `<div class="doc-match">${query ? `<span class="doc-line">Line ${m.line}</span>` : ''}${query ? `<pre>${highlighted}</pre>` : highlighted}</div>`;
      }).join('');
      return `
        <div class="doc-section">
          <h3 class="doc-title">${escapeHtml(doc.title)}</h3>
          ${matchesHtml}
        </div>
      `;
    }).join('<hr style="border-color: var(--border); margin: 20px 0;">');
  } catch (err) {
    container.innerHTML = '<p style="color: var(--danger);">Failed to load documentation.</p>';
  }
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function formatMarkdown(text) {
  // Simple markdown rendering
  return text
    .replace(/^### (.+)$/gm, '<h4 style="margin: 12px 0 4px;">$1</h4>')
    .replace(/^## (.+)$/gm, '<h3 style="margin: 16px 0 8px; border-bottom: 1px solid var(--border); padding-bottom: 4px;">$1</h3>')
    .replace(/^# (.+)$/gm, '<h2 style="margin: 20px 0 12px;">$1</h2>')
    .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre style="background: var(--bg-secondary); padding: 12px; border-radius: 4px; overflow-x: auto;">$2</pre>')
    .replace(/`([^`]+)`/g, '<code style="background: var(--bg-secondary); padding: 2px 6px; border-radius: 3px;">$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\|(.+)\|/g, (match) => {
      const cells = match.split('|').filter(c => c.trim());
      if (cells.every(c => c.trim().match(/^[-:]+$/))) return '';
      return '<div style="display: flex; gap: 16px;">' + cells.map(c => `<span style="flex: 1;">${c.trim()}</span>`).join('') + '</div>';
    })
    .replace(/^- (.+)$/gm, '<div style="padding-left: 16px;">• $1</div>')
    .replace(/\n\n/g, '<br><br>')
    .replace(/\n/g, '<br>');
}
