const api = globalThis.browser ?? globalThis.chrome;

const openHome = () => api.tabs.create({ url: api.runtime.getURL('yourhome.html') });

api.action.onClicked.addListener(openHome);

api.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') openHome();
});
