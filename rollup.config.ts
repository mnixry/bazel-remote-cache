import commonjs from '@rollup/plugin-commonjs'
import json from '@rollup/plugin-json'
import nodeResolve from '@rollup/plugin-node-resolve'
import typescript from '@rollup/plugin-typescript'

const config = {
  input: {
    index: 'src/index.ts',
    server: 'src/server.ts',
    post: 'src/post.ts'
  },
  output: {
    dir: 'dist',
    format: 'es',
    sourcemap: true
  },
  plugins: [
    typescript(),
    nodeResolve({ preferBuiltins: true }),
    commonjs(),
    json()
  ]
}

export default config
