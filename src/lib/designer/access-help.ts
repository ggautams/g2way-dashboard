import 'server-only';

import type { AccessHelp } from './access';
import { propertyHelp, schemaHelp } from './help';

/**
 * The access matrix's help text: g2way's rustdoc for `ApiAccess` and
 * `TypeFields`, and the owner's own `access` description (`Policy` or
 * `KeySession`), read on the server like every designer's help.
 */
export function accessFieldHelp(owner: 'Policy' | 'KeySession'): AccessHelp {
  return {
    access: propertyHelp(owner, 'access'),
    entry: schemaHelp('ApiAccess'),
    allowed_types: propertyHelp('ApiAccess', 'allowed_types'),
    restricted_types: propertyHelp('ApiAccess', 'restricted_types'),
    disable_introspection: propertyHelp('ApiAccess', 'disable_introspection'),
    max_query_depth: propertyHelp('ApiAccess', 'max_query_depth'),
    type_fields: schemaHelp('TypeFields'),
    'type_fields.name': propertyHelp('TypeFields', 'name'),
    'type_fields.fields': propertyHelp('TypeFields', 'fields'),
  };
}
