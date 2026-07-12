# CRM architecture — release 1.0.9

## Dependency direction

```text
React pages
    ↓
src/api.ts compatibility facade → data-provider policy
    ↓
Express routes → validation → domain utilities (financial/date)
    ↓
OwnedRepository contract
    ↓
Firestore | SQLite adapter | Supabase adapter
```

Dependencies point downward. Pages do not access a server database, route
handlers do not implement adapter-specific ownership rules, and adapters do not
contain HTTP or UI logic.

## Boundaries introduced through 1.0.9

- `shared/financial.ts` is the only source for quote and invoice totals.
- `shared/date.ts` owns month arithmetic and real-date validation.
- `server/crmValidation.ts` and `server/userValidation.ts` own input schemas.
- `server/repositories/ownedRepository.ts` owns tenant-scoped CRUD, immutable
  ownership fields, and reference checks behind `OwnedRepository` and
  `FirestoreLikeStore` contracts.
- `src/dataProvider.ts` owns frontend data-provider selection.
- `server/crmApi.ts` remains the HTTP compatibility facade; direct generic CRUD
  access is delegated to the repository.

## Functions and side effects

Pure calculations and validation stay in `shared/` or schema modules. Database,
network, clock, and browser-storage effects remain at repository, adapter, route,
or frontend facade boundaries. Repository operations require an explicit owner
UID, so tenant isolation cannot be omitted by an individual route.

## Inheritance decision

The application does not have a defective inheritance hierarchy. SQLite,
Supabase, and Firestore are interchangeable capabilities, not subtypes with
shared mutable lifecycle state. The implementation therefore uses contracts and
composition. Adding base classes would increase coupling without adding safety.

## Compatibility debt kept intentionally

`src/api.ts` and `server/crmApi.ts` are still large compatibility facades. They
are retained in 1.x to avoid changing the public API and every page import in one
release. New business rules must not be added directly to them: put new rules in
domain modules and new data access behind repositories. Future extractions can
split routes and frontend domains incrementally while the integration suite
locks the existing contract.
