import { h } from "preact";
import htm from "htm";
import { Credentials } from "../credentials/index.js";

const html = htm.bind(h);

export const CredentialsRoute = ({ onRestartRequired = () => {} }) => html`
  <${Credentials} onRestartRequired=${onRestartRequired} />
`;
