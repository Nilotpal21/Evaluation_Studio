import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const thisFilePath = fileURLToPath(import.meta.url);
const scenariosDir = path.dirname(thisFilePath);
const scenarioFiles = fs
  .readdirSync(scenariosDir)
  .filter((entry) => entry.endsWith('.mjs') && entry !== 'index.mjs')
  .sort();

const loadedScenarios = await Promise.all(
  scenarioFiles.map(async (entry) => {
    const scenarioModule = await import(pathToFileURL(path.join(scenariosDir, entry)).href);
    return scenarioModule.scenario ?? null;
  }),
);

const scenarioIds = new Set();
export const SCENARIOS = loadedScenarios.filter((scenario) => {
  if (!scenario) {
    return false;
  }

  if (scenarioIds.has(scenario.id)) {
    throw new Error(`Duplicate Studio video evidence scenario id "${scenario.id}".`);
  }

  scenarioIds.add(scenario.id);
  return true;
});

export function getScenarioById(id) {
  return SCENARIOS.find((scenario) => scenario.id === id) ?? null;
}
