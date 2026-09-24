/** Resolve an explicit VS Code folder/URI without guessing in a multi-root window. */
import * as path from 'node:path';
import {statSync} from 'node:fs';

export function resolveWorkspaceFolder<T extends {uri: {scheme: string; toString(): string}}>(
  folders: readonly T[] | undefined,
  requested?: T | T['uri'],
): T {
  if (!folders?.length) throw new Error('Open a package workspace first.');
  if (requested === undefined) {
    if (folders.length !== 1) {
      throw new Error('Choose a package workspace explicitly in a multi-root window.');
    }
    return folders[0];
  }
  if (requested === null || typeof requested !== 'object') {
    throw new Error('Pass a workspace folder or URI to PerfChecker.');
  }
  const uri = 'uri' in requested ? requested.uri : requested;
  if (!uri || typeof uri !== 'object' || uri.scheme !== 'file' || typeof uri.toString !== 'function') {
    throw new Error('PerfChecker requires a local file workspace folder.');
  }
  const folder = folders.find(candidate => candidate.uri.toString() === uri.toString());
  if (!folder) throw new Error('The selected PerfChecker folder is not an open workspace folder.');
  return folder;
}

let selectedWorkspaceUri: string | undefined;

export function selectWorkspaceFolder<T extends {uri: {scheme: string; toString(): string}}>(
  folders: readonly T[] | undefined, requested?: T | T['uri'],
): T {
  const folder = resolveWorkspaceFolder(folders, requested);
  selectedWorkspaceUri = folder.uri.toString();
  return folder;
}

export function currentWorkspaceFolder<T extends {uri: {scheme: string; toString(): string}}>(
  folders: readonly T[] | undefined,
): T {
  if (selectedWorkspaceUri === undefined) return resolveWorkspaceFolder(folders);
  const folder = folders?.find(candidate => candidate.uri.toString() === selectedWorkspaceUri);
  if (!folder) throw new Error('The selected PerfChecker folder is no longer open. Choose it again.');
  return folder;
}

type ProjectSetting = 'runnerProject' | 'scenarioProject';
type ProjectConfiguration = {
  get<T>(key: ProjectSetting, fallback: T): T;
  inspect?<T>(key: ProjectSetting): {
    workspaceFolderValue?: T; workspaceValue?: T; globalValue?: T;
  } | undefined;
};

function isFile(file: string): boolean {
  try { return statSync(file).isFile(); } catch { return false; }
}

/** Prefer the conventional controller only when the default `perf` is absent. */
export function resolveControllerProject(root: string, settings: ProjectConfiguration,
  key: ProjectSetting = 'runnerProject'): {project: string; reason: string} {
  const configured = settings.get(key, 'perf');
  const values = settings.inspect?.(key);
  const explicit = values?.workspaceFolderValue !== undefined ||
    values?.workspaceValue !== undefined || values?.globalValue !== undefined;
  const defaultProject = path.resolve(root, configured);
  const conventional = path.resolve(root, 'perf', 'controller');
  const fallback = !explicit && configured === 'perf' &&
    !isFile(path.join(defaultProject, 'Project.toml')) &&
    isFile(path.join(conventional, 'Project.toml'));
  const project = fallback ? conventional : defaultProject;
  if (!isFile(path.join(project, 'Project.toml'))) {
    throw new Error(`PerfChecker controller Project.toml not found at ${path.join(project, 'Project.toml')}. Configure perfchecker.${key} for this workspace folder.`);
  }
  return {project, reason: fallback ? 'default perf absent; using perf/controller' :
    explicit ? `explicit perfchecker.${key}` : `default perfchecker.${key}`};
}
