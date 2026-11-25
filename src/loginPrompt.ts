/**
 * The LEXIS browser login (py4lexis device flow) cannot open a browser from the extension host's
 * worker. py4lexis prints the login URL; QaaS shows it as a notification with a button, the user
 * signs in in the browser, and the login continues on its own.
 */

import * as vscode from "vscode";
import { PRODUCTION_AAI_URL } from "./core/devEnv";
import { parseLoginPrompt } from "./core/loginUrl";

/** Show the login notification when `text` contains py4lexis's login URL. */
export function offerLogin(text: string): void {
  const prompt = parseLoginPrompt(text);
  if (!prompt) {
    return;
  }
  const production = prompt.host === new URL(PRODUCTION_AAI_URL).host;
  const code = prompt.code ? ` and confirm code ${prompt.code}` : "";
  const where = production
    ? ""
    : ` The login page is on ${prompt.host}, not the LEXIS production login (${new URL(PRODUCTION_AAI_URL).host}).`;
  void vscode.window
    .showInformationMessage(
      `QaaS: sign in to LEXIS. Click Open Login Page${code} in the browser; QaaS continues on its own once you are signed in.${where}`,
      "Open Login Page",
    )
    .then((choice) => {
      if (choice) {
        void vscode.env.openExternal(vscode.Uri.parse(prompt.url));
      }
    });
}
