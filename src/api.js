
import axios from "axios";

const api = axios.create({
  baseURL: "/api",
  timeout: 15000,
});

const TOKEN_KEY = "weather_station_token";

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

export async function login() {
  const APP_ID = import.meta.env.VITE_WEATHER_APP_ID;
  const SECRET_KEY = import.meta.env.VITE_WEATHER_SECRET_KEY;

  if (!APP_ID || !SECRET_KEY) {
    throw new Error("Missing credentials. Check your .env.local file.");
  }

  const { data } = await api.post(
    "/login/getToken",
    {
      appid: APP_ID,
      secretKey: SECRET_KEY,
    },
    {
      headers: {
        "Content-Type": "application/json",
      },
    }
  );

  if (data.errcode !== 0 || !data.token) {
    throw new Error(
      `Token generation failed: ${data.errmsg} (${data.errcode})`
    );
  }

  localStorage.setItem(TOKEN_KEY, data.token);
  return data.token;
}

async function request(url, params = {}) {
  let token = localStorage.getItem(TOKEN_KEY);

  if (!token) {
    token = await login();
  }

  const send = (credential) =>
    api.get(url, {
      params,
      headers: {
        TOKEN: credential,
      },
    });

  let response = await send(token);
  let result = response.data;

  const message = String(result.errmsg || "").toLowerCase();

  const tokenExpired =
    result.errcode !== 0 &&
    (
      message.includes("token") ||
      message.includes("credential") ||
      message.includes("凭证") ||
      message.includes("过期") ||
      message.includes("登陆失效") ||
      message.includes("登录失效")
    );

  if (tokenExpired) {
    clearToken();
    token = await login();
    response = await send(token);
    result = response.data;
  }

  if (result.errcode !== 0) {
    throw new Error(result.errmsg || "API request failed");
  }

  return result;
}

export async function getGateways() {
  const result = await request("/v1/gateway/getGatewayOption");

  return Array.isArray(result.data) ? result.data : [];
}

export async function getSensorData(deviceNo, startDate, endDate) {
  if (!deviceNo) {
    throw new Error("Please select a gateway.");
  }

  if (!startDate || !endDate) {
    throw new Error("Please select both start and end date/time.");
  }

  if (new Date(startDate.replace(" ", "T")) > new Date(endDate.replace(" ", "T"))) {
    throw new Error("Start date/time must be before end date/time.");
  }

  const result = await request(
    "/v1/gateway/getMeteorologicalData",
    {
      no: deviceNo,
      startDate,
      endDate,
    }
  );

  return Array.isArray(result.list) ? result.list : [];
}
