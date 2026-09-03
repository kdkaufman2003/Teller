export type PartnerId = "hasslefreeac";

export type PartnerDefinition = {
  id: PartnerId;
  name: string;
  shortName: string;
  description: string;
  /** Connected platform shown in Settings / sidebar */
  platformLabel: string;
  defaultCompanyName: string;
  defaultLegalName: string;
  defaultIndustryId: string;
};
