const configuredApiBase = import.meta.env.VITE_API_BASE ?? import.meta.env.VITE_API_URL;

export const API_BASE = configuredApiBase
  ? `${configuredApiBase.replace(/\/+$/, '')}${configuredApiBase.replace(/\/+$/, '').endsWith('/api/v1') ? '' : '/api/v1'}`
  : import.meta.env.PROD ? '/api/v1' : 'http://localhost:5000/api/v1';
