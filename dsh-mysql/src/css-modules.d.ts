/**
 * CSS Modules are compiled inside the client bundle (not by tsc), so TypeScript
 * only needs to know the import yields the hashed class-name map.
 *
 * @module dsh-mysql/css-modules
 */

declare module '*.module.css' {
  /** Local class name → emitted (hashed) class name. */
  const classes: Readonly<Record<string, string>>
  export default classes
}
