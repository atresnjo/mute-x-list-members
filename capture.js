// Runs in the page's own JS world at document_start so it sees X's ListMembers
// request. Its URL carries the current GraphQL query id and feature flags,
// which change often. content.js reads it from a DOM attribute.
(() => {
  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    if (/\/graphql\/[^/]+\/ListMembers\?/.test(String(url))) {
      document.documentElement.dataset.muteListMembersUrl = new URL(url, location.href).href;
    }
    return open.apply(this, arguments);
  };
})();
