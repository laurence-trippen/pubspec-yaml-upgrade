import * as vscode from 'vscode'
import { decorateDiscreet, getDecoratorForUpdate, getUpdateDescription } from './decorations'
import { getIgnorePattern, isDependencyIgnored } from './ignorePattern'
import { getCachedNpmData, getPossibleUpgrades, refreshPackageJsonData } from './npm'
import { DependencyGroups } from './packageJson'
import { AsyncState } from './types'
import { TextEditorDecorationType } from 'vscode'
import { getConfig } from './config'
import { getDependencyInformation, isPubspecYaml } from './pubspecYaml'

interface DecorationWrapper {
  line: number
  text: string
  decoration: TextEditorDecorationType
}

function isDiffView() {
  const schemes = vscode.window.visibleTextEditors.map((editor) => editor.document.uri.scheme)
  return schemes.length === 2 && schemes.includes('git') && schemes.includes('file')
}

// If a user opens the same package.json several times quickly, several "loads" of decorators will
// be ongoing at the same time. So here we keep track of the latest start time and only use that.
const decorationStart: Record<string, number> = {}

let rowToDecoration: Record<number, DecorationWrapper | undefined> = {}

export const handleFileDecoration = (document: vscode.TextDocument) => {
  if (isDiffView()) {
    return
  }

  if (!isPubspecYaml(document)) {
    return
  }

  const startTime = new Date().getTime()
  decorationStart[document.fileName] = startTime

  void loadDecoration(document, startTime)
}

const loadDecoration = async (document: vscode.TextDocument, startTime: number) => {
  const text = document.getText()
  const dependencyGroups = getDependencyInformation(text)

  const textEditor = getTextEditorFromDocument(document)
  if (textEditor === undefined) {
    return
  }

  const promises = refreshPackageJsonData(document.getText(), document.uri.fsPath)

  try {
    await Promise.race([...promises, Promise.resolve()])
  } catch (e) {
    //
  }

  // initial paint
  const stillLoading = promises.length !== 0
  paintDecorations(document, dependencyGroups, stillLoading, startTime)

  return waitForPromises(promises, document, dependencyGroups, startTime)
}

const waitForPromises = async (
  promises: Promise<void>[],
  document: vscode.TextDocument,
  dependencyGroups: DependencyGroups[],
  startTime: number,
) => {
  let newSettled = false

  if (promises.length === 0) {
    return
  }

  promises.forEach((promise) => {
    void promise
      .then(() => {
        newSettled = true
      })
      .catch(() => {
        //
      })
  })

  const interval = setInterval(() => {
    if (newSettled === true) {
      newSettled = false
      paintDecorations(document, dependencyGroups, true, startTime)
    }
  }, 1000)

  await Promise.allSettled(promises)

  clearInterval(interval)

  return paintDecorations(document, dependencyGroups, false, startTime)
}

const paintDecorations = (
  document: vscode.TextDocument,
  dependencyGroups: DependencyGroups[],
  stillLoading: boolean,
  startTime: number,
) => {
  if (decorationStart[document.fileName] !== startTime) {
    return
  }

  const textEditor = getTextEditorFromDocument(document)
  if (textEditor === undefined) {
    return
  }

  const ignorePatterns = getIgnorePattern()

  if (stillLoading) {
    paintLoadingOnDependencyGroups(dependencyGroups, document, textEditor)
  } else {
    clearLoadingOnDependencyGroups(dependencyGroups)
  }

  const dependencies = dependencyGroups.map((d) => d.deps).flat()

  dependencies.forEach((dep) => {
    if (isDependencyIgnored(dep.dependencyName, ignorePatterns)) {
      return
    }

    const lineText = document.lineAt(dep.line).text

    const range = new vscode.Range(
      new vscode.Position(dep.line, lineText.length),
      new vscode.Position(dep.line, lineText.length),
    )

    const npmCache = getCachedNpmData(dep.dependencyName)
    if (npmCache === undefined) {
      return
    }

    if (npmCache.asyncstate === AsyncState.Rejected) {
      const text = 'Dependency not found'
      const notFoundDecoration = decorateDiscreet(text)
      if (updateCache(notFoundDecoration, range.start.line, text)) {
        setDecorator(notFoundDecoration, textEditor, range)
      }
      return
    }

    if (npmCache.item === undefined) {
      const msUntilRowLoading = getConfig().msUntilRowLoading
      if (
        msUntilRowLoading !== 0 &&
        (msUntilRowLoading < 100 ||
          npmCache.startTime + getConfig().msUntilRowLoading < new Date().getTime())
      ) {
        const text = 'Loading...'
        const decorator = decorateDiscreet(text)
        if (updateCache(decorator, range.start.line, text)) {
          setDecorator(decorator, textEditor, range)
        }
      }
      return
    }

    const possibleUpgrades = getPossibleUpgrades(
      npmCache.item.npmData,
      dep.currentVersion,
      dep.dependencyName,
    )

    let decorator: TextEditorDecorationType | undefined
    let text: string | undefined
    if (possibleUpgrades.major !== undefined) {
      // TODO add info about patch version?
      text = getUpdateDescription(possibleUpgrades.major.version, possibleUpgrades.existingVersion)
      decorator = getDecoratorForUpdate('major', text)
    } else if (possibleUpgrades.minor !== undefined) {
      text = getUpdateDescription(possibleUpgrades.minor.version, possibleUpgrades.existingVersion)
      decorator = getDecoratorForUpdate('minor', text)
    } else if (possibleUpgrades.patch !== undefined) {
      text = getUpdateDescription(possibleUpgrades.patch.version, possibleUpgrades.existingVersion)
      decorator = getDecoratorForUpdate('patch', text)
    } else if (possibleUpgrades.prerelease !== undefined) {
      text = getUpdateDescription(
        possibleUpgrades.prerelease.version,
        possibleUpgrades.existingVersion,
      )
      decorator = getDecoratorForUpdate('prerelease', text)
    } else if (possibleUpgrades.validVersion === false) {
      text = 'Failed to parse version'
      decorator = decorateDiscreet(text)
    } else if (possibleUpgrades.existingVersion === false) {
      text = 'current version not found'
      decorator = decorateDiscreet(text)
    }

    if (decorator === undefined || text === undefined) {
      return
    }

    if (updateCache(decorator, range.start.line, text)) {
      setDecorator(decorator, textEditor, range)
    }
  })
}

const paintLoadingOnDependencyGroups = (
  dependencyGroups: DependencyGroups[],
  document: vscode.TextDocument,
  textEditor: vscode.TextEditor,
) => {
  dependencyGroups.forEach((lineLimit) => {
    const lineText = document.lineAt(lineLimit.startLine).text
    const range = new vscode.Range(
      new vscode.Position(lineLimit.startLine, lineText.length),
      new vscode.Position(lineLimit.startLine, lineText.length),
    )
    const text = 'Loading updates...'
    const loadingUpdatesDecoration = decorateDiscreet(text)
    if (updateCache(loadingUpdatesDecoration, range.start.line, text)) {
      setDecorator(loadingUpdatesDecoration, textEditor, range)
    }
  })
}

const clearLoadingOnDependencyGroups = (dependencyGroups: DependencyGroups[]) => {
  dependencyGroups.forEach((lineLimit) => {
    const current = rowToDecoration[lineLimit.startLine]
    if (current) {
      current.decoration.dispose()
      rowToDecoration[lineLimit.startLine] = undefined
    }
  })
}

const setDecorator = (
  decorator: TextEditorDecorationType,
  textEditor: vscode.TextEditor,
  range: vscode.Range,
) => {
  textEditor.setDecorations(decorator, [
    {
      range,
    },
  ])
}

const getTextEditorFromDocument = (document: vscode.TextDocument) => {
  return vscode.window.visibleTextEditors.find((textEditor) => {
    return textEditor.document === document
  })
}

export const clearDecorations = () => {
  Object.values(rowToDecoration).forEach((v) => {
    v?.decoration.dispose()
  })
  rowToDecoration = {}
}

const updateCache = (decoration: TextEditorDecorationType, line: number, text: string) => {
  const current = rowToDecoration[line]
  if (current === undefined || current.text !== text) {
    if (current) {
      current.decoration.dispose()
    }
    rowToDecoration[line] = {
      decoration,
      line,
      text,
    }
    return true
  } else {
    return false
  }
}
