export class EntityControlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EntityControlError";
  }
}

export const ENTITY_CONTROL_MESSAGES = {
  accountWrongEntity: "This account belongs to another company.",
  documentWrongEntity: "This document belongs to another company.",
  paymentWrongEntity: "This payment belongs to another company.",
  bankAccountWrongEntity: "This bank account belongs to another company.",
  crossEntityAllocation:
    "This payment cannot be applied to a document from another company.",
  crossEntityDeposit: "This deposit cannot be applied to an invoice from another company.",
} as const;
