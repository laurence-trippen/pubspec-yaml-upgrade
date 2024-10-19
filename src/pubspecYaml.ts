import * as vscode from 'vscode'
import { parse as parseYaml } from 'yaml'

export interface DependencyGroups {
  startLine: number
  deps: Dependency[]
}

export interface Dependency {
  dependencyName: string
  currentVersion: string
  line: number
}

// type PubspecYaml = {
//   dependencies: Record<string, string>;
//   dev_dependencies: Record<string, string>;
// };

export const getDependencyInformation = (yamlAsString: string): DependencyGroups[] => {
  const pubspecYaml = parseYaml(yamlAsString) as unknown

  // eslint-disable-next-line no-console
  console.log(pubspecYaml)

  return []
}

export const isPubspecYaml = (document: vscode.TextDocument) => {
  // Is checking both slashes necessary? Test on linux and mac.
  return (
    document.fileName.endsWith('\\pubspec.yml') ||
    document.fileName.endsWith('/pubspec.yml') ||
    document.fileName.endsWith('\\pubspec.yaml') ||
    document.fileName.endsWith('/pubspec.yaml')
  )
}
