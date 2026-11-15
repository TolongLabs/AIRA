// Copies the files the compiler does not emit into dist/, so the built service finds them beside its code.
import { cpSync } from 'node:fs'

cpSync('src/storage/migrations', 'dist/src/storage/migrations', { recursive: true })
