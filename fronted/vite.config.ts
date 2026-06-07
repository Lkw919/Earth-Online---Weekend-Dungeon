import { defineConfig, loadEnv } from 'vite'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  const envDir = '..'
  const env = loadEnv(mode, envDir, '')

  return {
    envDir,
    plugins: [
      react(),
      tailwindcss(),
      {
        name: 'inject-amap-security',
        transformIndexHtml(html) {
          const code = env.VITE_AMAP_SECURITY_CODE || ''
          return html.replace(
            /securityJsCode:\s*['"][^'"]*['"]/,
            `securityJsCode: '${code}'`,
          )
        },
      },
    ],
    resolve: {
      alias: {
        '@': '/src',
      },
    },
    server: {
      // 固定监听所有网卡,手机才能通过局域网 IP 访问(不能只用 localhost)
      host: '0.0.0.0',
      port: 5173,
      proxy: {
        '/api': {
          target: 'http://localhost:8000',
          changeOrigin: true,
        },
        '/health': {
          target: 'http://localhost:8000',
          changeOrigin: true,
        },
      },
    },
    assetsInclude: ['**/*.svg', '**/*.csv'],
  }
})
