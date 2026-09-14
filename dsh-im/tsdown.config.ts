import { defineConfig } from 'tsdown'
export default defineConfig({entry:{index:'src/index.ts'},dts:true,outDir:'lib',format:'esm',fixedExtension:false})
