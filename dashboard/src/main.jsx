import React from "react";
import ReactDOM from "react-dom/client";
import { Auth0Provider } from "@auth0/auth0-react";

import App from "./App.jsx";
import { auth0AuthorizationParams, auth0ClientId, auth0Domain, auth0Enabled } from "./site/auth/auth0-config.js";
import "./styles/globals.css";

const appTree = (
  <React.StrictMode>
    {auth0Enabled ? (
      <Auth0Provider
        domain={auth0Domain}
        clientId={auth0ClientId}
        authorizationParams={auth0AuthorizationParams()}
      >
        <App />
      </Auth0Provider>
    ) : (
      <App />
    )}
  </React.StrictMode>
);

ReactDOM.createRoot(document.getElementById("root")).render(appTree);
