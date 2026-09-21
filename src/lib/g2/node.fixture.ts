/** A `/g2/node` body as `crates/g2-admin/src/dashboard.rs` builds it. */
export function nodeBody() {
  return {
    node_id: 'g2way-7d9f-abc',
    version: '0.9.0',
    uptime_secs: 3725,
    routes: 2,
    apis: [
      {
        api_id: 'orders',
        name: 'Orders',
        org_id: 'default',
        listen_path: '/orders/',
        target_url: 'http://orders:8080',
        target_list: ['http://orders-a:8080', 'http://orders-b:8080'],
        live_targets: ['http://orders-a:8080', 'http://orders-b:8080'],
        target_health: [true, false],
        service_discovery: {
          endpoint: 'http://consul:8500/v1/catalog/service/orders',
          last_success_unix_secs: 1_700_000_000,
          last_error: null,
        },
        graphql_schema_sync: null,
        circuit_breaker: 'half_open',
        auth_mode: 'auth_token',
      },
      {
        api_id: 'catalog',
        name: 'Catalog',
        org_id: 'default',
        listen_path: '/graphql/',
        target_url: 'http://catalog:4000',
        target_list: [],
        live_targets: ['http://catalog:4000'],
        target_health: null,
        service_discovery: null,
        graphql_schema_sync: { last_success_unix_secs: null, last_error: 'connection refused' },
        circuit_breaker: null,
        auth_mode: 'keyless',
      },
    ],
  };
}
