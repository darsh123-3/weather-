// GET /api/gateways → list of gateways/stations on the account.
import { handle, vendorGet } from "./_vendor.js";

export default handle(async () => {
  const result = await vendorGet("/v1/gateway/getGatewayOption");
  return { errcode: 0, data: Array.isArray(result.data) ? result.data : [] };
});
