import { watch, type FSWatcher } from "fs";

let watcher: FSWatcher | null = null;
let debounce: ReturnType<typeof setTimeout> | null = null;

export function watchTerrainFile(filePath: string, onChanged: () => void): void {
  stopWatching();
  watcher = watch(filePath, () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(onChanged, 500);
  });
}

export function stopWatching(): void {
  if (debounce) { clearTimeout(debounce); debounce = null; }
  if (watcher) { watcher.close(); watcher = null; }
}
