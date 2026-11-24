const nock = require("nock");

// Isolate HTTP mocking per Jest environment so local transport tests can opt in
// without an outer Nock layer continuing to block their fixture connections.
nock.disableNetConnect();

afterAll(() => {
    nock.cleanAll();
    nock.restore();
});
