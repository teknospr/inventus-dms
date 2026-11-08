module.exports = {
  // The DMS app always talks to production. Forced at startup so a workstation
  // can never accidentally point at a dev/preview server.
  //
  // No API key lives here: the source and the downloads are public. Each
  // workstation gets its own device token when it activates its license.
  serverUrl: 'https://inventuscrm.com',
};
