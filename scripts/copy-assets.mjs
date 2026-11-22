// Copies the files the compiler does not emit into dist/, so the built service finds them beside its code.
import { cpSync } from 'node:fs'

cpSync('src/storage/migrations', 'dist/src/storage/migrations', { recursive: true })
cpSync('scripts/updater/offline-snapshot.py', 'dist/scripts/updater/offline-snapshot.py')
