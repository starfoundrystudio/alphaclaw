export const kDefaultUiTab = "general";

export const kNavSections = [
  {
    label: "Setup",
    items: [
      { id: "general", label: "General" },
    ],
  },
  {
    label: "Monitoring",
    items: [
      { id: "cron", label: "Cron" },
      { id: "usage", label: "Usage" },
      { id: "doctor", label: "Doctor" },
      { id: "watchdog", label: "Watchdog" },
    ],
  },
  {
    label: "Config",
    items: [
      { id: "models", label: "Models" },
      { id: "credentials", label: "Credentials" },
      { id: "envars", label: "Runtime Configuration" },
      { id: "webhooks", label: "Webhooks" },
      { id: "nodes", label: "Nodes" },
    ],
  },
];

export const getSelectedNavId = ({ isBrowseRoute = false, location = "" } = {}) => {
  if (isBrowseRoute) return "browse";
  if (location.startsWith("/telegram")) return "";
  if (location.startsWith("/chat")) return "";
  if (location.startsWith("/models")) return "models";
  if (location.startsWith("/agents")) return "agents";
  if (location.startsWith("/providers")) return "models";
  if (location.startsWith("/watchdog")) return "watchdog";
  if (location.startsWith("/cron")) return "cron";
  if (location.startsWith("/usage")) return "usage";
  if (location.startsWith("/doctor")) return "doctor";
  if (location.startsWith("/nodes")) return "nodes";
  if (location.startsWith("/credentials")) return "credentials";
  if (location.startsWith("/envars")) return "envars";
  if (location.startsWith("/webhooks")) return "webhooks";
  return kDefaultUiTab;
};
