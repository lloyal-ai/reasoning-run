/**
 * `.eta` files are template sources. esbuild's `--loader:.eta=text` inlines
 * them as string constants into the bundle at build time — no fs.readFileSync,
 * no shipped prompts/ directory. Module declaration here so TypeScript
 * accepts the imports outside the build context.
 */
declare module '*.eta' {
  const content: string;
  export default content;
}
