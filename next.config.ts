import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  experimental: {
    // `forbidden()` and `src/app/forbidden.tsx`: pages a role cannot use answer a
    // real 403 (ADR-0005). Experimental in Next 16; `next` is pinned exactly.
    authInterrupts: true,
  },
};

export default nextConfig;
