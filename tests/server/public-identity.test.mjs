import { test } from "node:test";
import assert from "node:assert/strict";
import { shortPlayerId, displayedBallId } from "../../public/js/public-identity.mjs";

test("public names include an immutable short ID to distinguish identical nicknames and real names", () => {
  assert.equal(shortPlayerId("8e935bc5-1234-5678"), "8E935BC5");
  assert.equal(shortPlayerId("9e58e84d-1234-5678"), "9E58E84D");
  assert.equal(displayedBallId("8e935bc5-1234-5678:12"), "8E935BC5 / 12");
});
