import { createTradesPack } from "./trades-base";

export const tradesHvacPack = createTradesPack({
  id: "trades-hvac",
  name: "HVAC",
  shortName: "HVAC",
  category: "Trades & field service",
  tradeLabel: "HVAC",
  tagline: "Equipment, installs, and service",
  description:
    "Heating and cooling contractors, dealers, and service shops. Job costing, equipment vs labor, and integrations.",
  recommended: true,
  answerDefaults: {
    businessModel: "mixed",
    customerNoun: "dealers",
    revenueStreams: ["equipment", "labor", "service", "parts", "maintenance"],
  },
});

export const tradesElectricalPack = createTradesPack({
  id: "trades-electrical",
  name: "Electrical",
  shortName: "Electrical",
  category: "Trades & field service",
  tradeLabel: "electrical",
  tagline: "Installs, service calls, and material sales",
  description:
    "Residential and commercial electricians. Split labor, materials, and service revenue on every invoice.",
  answerDefaults: {
    businessModel: "contractor",
    customerNoun: "customers",
    revenueStreams: ["equipment", "labor", "service", "parts"],
  },
});

export const tradesPlumbingPack = createTradesPack({
  id: "trades-plumbing",
  name: "Plumbing",
  shortName: "Plumbing",
  category: "Trades & field service",
  tradeLabel: "plumbing",
  tagline: "Service, repair, and repipe jobs",
  description:
    "Plumbing contractors and service companies. Track jobs from estimate through invoice with parts and labor.",
  answerDefaults: {
    businessModel: "service",
    customerNoun: "homeowners",
    revenueStreams: ["labor", "service", "parts"],
  },
});

export const tradesRoofingPack = createTradesPack({
  id: "trades-roofing",
  name: "Roofing",
  shortName: "Roofing",
  category: "Trades & field service",
  tradeLabel: "roofing",
  tagline: "Install projects and storm repair",
  description:
    "Roofing contractors and repair crews. Materials, labor, and warranty lines on a job-by-job basis.",
  answerDefaults: {
    businessModel: "contractor",
    customerNoun: "homeowners",
    revenueStreams: ["equipment", "labor", "service", "warranty"],
  },
});

export const tradesMechanicalPack = createTradesPack({
  id: "trades-mechanical",
  name: "Mechanical / Commercial",
  shortName: "Mechanical",
  category: "Trades & field service",
  tradeLabel: "mechanical",
  tagline: "Commercial installs and PM contracts",
  description:
    "Mechanical and commercial trades. Larger jobs, maintenance agreements, and subcontractor costs.",
  answerDefaults: {
    businessModel: "contractor",
    customerNoun: "clients",
    revenueStreams: ["equipment", "labor", "service", "maintenance"],
  },
});

export const tradesGeneralPack = createTradesPack({
  id: "trades-general",
  name: "General contractor",
  shortName: "GC",
  category: "Trades & field service",
  tradeLabel: "contracting",
  tagline: "Multi-trade jobs and subs",
  description:
    "General contractors coordinating multiple trades. Job costing, subs, and mixed revenue on one books setup.",
  answerDefaults: {
    businessModel: "mixed",
    customerNoun: "customers",
    revenueStreams: ["equipment", "labor", "service", "parts"],
  },
});

export const tradeIndustryPacks = [
  tradesHvacPack,
  tradesElectricalPack,
  tradesPlumbingPack,
  tradesRoofingPack,
  tradesMechanicalPack,
  tradesGeneralPack,
];
