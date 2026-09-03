export type PartnerId = "hasslefreeac";

export type PartnerDefinition = {
  id: PartnerId;
  name: string;
  shortName: string;
  description: string;
  /** Product in the partner stack that Teller connects to */
  quoterLabel: string;
  defaultCompanyName: string;
  defaultLegalName: string;
  defaultIndustryId: string;
};
