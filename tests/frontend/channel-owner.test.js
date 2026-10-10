import { matchesSlackMemberQuery } from "../../lib/public/js/components/agents-tab/create-channel-modal/use-channel-owner.js";

describe("frontend/channel-owner", () => {
  const member = {
    name: "billk",
    realName: "Bill Krueger",
    handle: "bill.krueger",
  };

  it("matches every search word against display name, real name, and handle", () => {
    expect(matchesSlackMemberQuery(member, "")).toBe(true);
    expect(matchesSlackMemberQuery(member, "bill kru")).toBe(true);
    expect(matchesSlackMemberQuery(member, "KRUEGER")).toBe(true);
    expect(matchesSlackMemberQuery(member, "bill smith")).toBe(false);
  });
});
