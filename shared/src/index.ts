/**
 * Barrel export for the shared module. Client (Vite, via "@shared/*") and server
 * (Node CJS, via compiled dist) both import from here.
 */

export * from './types.js';
export * from './net.js';
export * from './step.js';
export * from './renderer.js';
export * from './species.js';
export * from './rng.js';
export * from './tiles.js';
export * from './world.js';
