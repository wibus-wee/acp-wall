export const METHODOLOGY_VERSION: string;
export const REASONS: Record<string, string>;
export function reasonLabel(reason?: string): string;
export function uncertaintyReasons(methods?: Record<string, {status: string; reason?: string}>): Record<string, number>;
export const STATUS: Record<string, { label: string; mark: string; description: string }>;
export const COLUMNS: Array<[string, string[], string]>;
export function summarize(methods?: Record<string, { status: string }>): Record<string, number>;
export function cellsFromMethods(methods?: Record<string, { status: string; note?: string }>): Array<{ key: string; scope: string; status: string; items: Array<{ method: string; status: string; note?: string }> }>;
export function runState(summary: Record<string, number>, setup?: {status: string}, violations?: Array<{where: string}>, methods?: Record<string, {status: string}>): string;
