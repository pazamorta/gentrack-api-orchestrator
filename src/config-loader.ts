import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { OrchestratorConfig } from './types';

const CONFIG_DIR = path.resolve(process.cwd(), 'config');

/**
 * Load orchestrator configuration from YAML files in the config directory.
 * Looks for backends.yaml and routes.yaml, or a single orchestrator.yaml.
 */
export function loadConfig(): OrchestratorConfig {
  const singleFile = path.join(CONFIG_DIR, 'orchestrator.yaml');

  if (fs.existsSync(singleFile)) {
    const content = fs.readFileSync(singleFile, 'utf-8');
    const config = yaml.load(content) as OrchestratorConfig;
    return validateConfig(config);
  }

  // Load split files
  const backendsFile = path.join(CONFIG_DIR, 'backends.yaml');
  const routesFile = path.join(CONFIG_DIR, 'routes.yaml');

  const backends = fs.existsSync(backendsFile)
    ? (yaml.load(fs.readFileSync(backendsFile, 'utf-8')) as OrchestratorConfig['backends']) || []
    : [];

  const routes = fs.existsSync(routesFile)
    ? (yaml.load(fs.readFileSync(routesFile, 'utf-8')) as OrchestratorConfig['routes']) || []
    : [];

  return validateConfig({ backends, routes });
}

/**
 * Save configuration back to YAML (single file mode).
 */
export function saveConfig(config: OrchestratorConfig): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
  const filePath = path.join(CONFIG_DIR, 'orchestrator.yaml');
  const content = yaml.dump(config, { indent: 2, lineWidth: 120 });
  fs.writeFileSync(filePath, content, 'utf-8');
}

function validateConfig(config: OrchestratorConfig): OrchestratorConfig {
  if (!config.backends) config.backends = [];
  if (!config.routes) config.routes = [];

  // Validate backend references in routes
  const backendIds = new Set(config.backends.map((b) => b.id));
  for (const route of config.routes) {
    for (const step of route.steps) {
      for (const call of step.calls) {
        if (!backendIds.has(call.backendId)) {
          console.warn(
            `[config] Route "${route.name}" step "${call.stepId}" references unknown backend "${call.backendId}"`
          );
        }
      }
    }
  }

  return config;
}
