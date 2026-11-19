import asyncio
import sys

from playwright.async_api import async_playwright

# Serve the repository root: python3 -m http.server 8800
URL = "http://127.0.0.1:8800/qaas-wasm/index.html"
XHR_SNIPPET = r'''
import json, qaas_pyodide
from qheappe_client.qclient import QClient
c = QClient("tok", "proj", load_machine_info=False)
c._session = qaas_pyodide.FetchClientSession()
r = c._run(c._request("GET", "http://127.0.0.1:8765/echo", params={"from": "chrome"}))
d = json.loads(r.body)
print("BROWSER sync QClient request:", r.status, d["query"], d["auth"])
r = await c._request("POST", "http://127.0.0.1:8765/echo", json_body={"x": 1})
print("BROWSER async QClient request:", r.status, json.loads(json.loads(r.body)["body"]))
c.close()
print("BROWSER close() via JSPI OK")
'''


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-proxy-server"])
        page = await b.new_page(viewport={"width": 1000, "height": 1100})
        logs = []
        page.on("console", lambda m: logs.append(m.text))
        await page.goto(URL)
        await page.wait_for_function("window.qaasReady || window.qaasError", timeout=600_000)
        print("status:", await page.inner_text("#status"))
        if await page.evaluate("window.qaasError || null"):
            print("\n".join(logs[-20:])); sys.exit(1)
        await page.click("#run")
        await page.wait_for_function("window.qaasRunDone", timeout=300_000)
        print(await page.inner_text("#out"))
        await page.screenshot(path="browser_demo.png", full_page=True)
        await page.evaluate("window.qaasRunDone=false")
        await page.fill("#code", XHR_SNIPPET)
        await page.click("#run")
        await page.wait_for_function("window.qaasRunDone", timeout=300_000)
        print(await page.inner_text("#out"))
        await b.close()

asyncio.run(main())
