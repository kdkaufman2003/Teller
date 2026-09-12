export type {
  AccountingContext,
} from "./context";
export { accountingContext } from "./context";
export type { EntityAuthContext, EntityMembershipSummary } from "./access";
export {
  assertEntityAccess,
  canAccessLegalEntity,
  grantEntityAccess,
  hasAllEntityAccess,
  listEntityMembershipsForProfile,
  revokeEntityAccess,
  userHasRestrictedEntityAccess,
} from "./access";
export type { ActiveLegalEntityContext } from "./active-context";
export {
  listAccessibleLegalEntities,
  persistActiveLegalEntity,
  resolveActiveLegalEntityContext,
} from "./active-context";
export {
  resolveDefaultLegalEntity,
  requireDefaultLegalEntity,
  loadLegalEntityForOrg,
  resolveAuthorizedLegalEntity,
} from "./resolver";
export {
  listLegalEntities,
  createLegalEntity,
  updateLegalEntity,
  archiveLegalEntity,
  setDefaultLegalEntity,
  seedDefaultLegalEntityViaRpc,
  organizationHasActiveHfacIntegration,
} from "./service";
export type {
  CreateLegalEntityInput,
  LegalEntityRow,
  LegalEntitySummary,
  LegalEntityType,
} from "./types";
export {
  assertSameOrganization,
  normalizeEntityCode,
  parseLegalEntityType,
  validateEntityCode,
} from "./validation";
