const FRAME_RUNTIME_NONCE = "classapp-bundle-runtime";

// A meta CSP survives document.open(); both frame stages must share one policy.
export const BUNDLE_FRAME_CSP = `default-src 'none'; img-src blob: data:; style-src blob: 'unsafe-inline'; script-src blob: 'nonce-${FRAME_RUNTIME_NONCE}'; font-src blob:; media-src blob:; connect-src 'none'; base-uri 'none'; form-action 'none'`;

const FRAME_RUNTIME_SCRIPT = `(function(){function scroll(x,y){parent.postMessage({type:"classapp:bundle-frame-scroll",x:x,y:y},"*")}addEventListener("wheel",function(event){if(!event.deltaX&&!event.deltaY)return;event.preventDefault();var unit=event.deltaMode===1?16:event.deltaMode===2?innerHeight:1;scroll(event.deltaX*unit,event.deltaY*unit)},{passive:false});var touch=null;addEventListener("touchstart",function(event){if(event.touches.length!==1){touch=null;return}touch={x:event.touches[0].clientX,y:event.touches[0].clientY}},{passive:false});addEventListener("touchmove",function(event){if(!touch||event.touches.length!==1)return;var next=event.touches[0];var x=touch.x-next.clientX;var y=touch.y-next.clientY;touch={x:next.clientX,y:next.clientY};if(!x&&!y)return;event.preventDefault();scroll(x,y)},{passive:false});function clearTouch(){touch=null}addEventListener("touchend",clearTouch);addEventListener("touchcancel",clearTouch);addEventListener("keydown",function(event){var y=event.key==="ArrowUp"?-40:event.key==="ArrowDown"?40:event.key==="PageUp"?-innerHeight*.85:event.key==="PageDown"?innerHeight*.85:event.key===" "||event.key==="Spacebar"?(event.shiftKey?-innerHeight*.85:innerHeight*.85):0;if(!y)return;event.preventDefault();scroll(0,y)});addEventListener("unload",function(){var urls=window.__classappBundleUrls||[];for(var index=0;index<urls.length;index+=1)URL.revokeObjectURL(urls[index])});parent.postMessage({type:"classapp:bundle-frame-ready"},"*")})()`;

/**
 * The opaque frame creates its own object URLs. Chrome 70 will reject object
 * URLs created by the parent because the two contexts have different opaque
 * origins, even though the bytes originated in the same application.
 */
export const BUNDLE_FRAME_SRC_DOC = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${BUNDLE_FRAME_CSP}"></head><body><script nonce="${FRAME_RUNTIME_NONCE}">(function(){function fail(error){parent.postMessage({type:"classapp:bundle-frame-error",message:error&&error.message||String(error)},"*")}addEventListener("message",function(event){if(event.source!==parent||!event.data||event.data.type!=="classapp:bundle-frame-load")return;try{var resources=event.data.resources||[];var urls=[];var byId=Object.create(null);for(var index=0;index<resources.length;index+=1){var resource=resources[index];var url=URL.createObjectURL(new Blob([resource.bytes],{type:resource.mime}));urls.push(url);byId[resource.content_id]=url}var parsed=new DOMParser().parseFromString(event.data.html,"text/html");var nodes=parsed.querySelectorAll("[data-bundle-ref]");for(var nodeIndex=0;nodeIndex<nodes.length;nodeIndex+=1){var node=nodes[nodeIndex];var id=node.getAttribute("data-bundle-ref");var target=byId[id];if(!target)throw new Error("Bundle frame resource is missing: "+id);var attributes=["href","src","xlink:href"];for(var attributeIndex=0;attributeIndex<attributes.length;attributeIndex+=1){var attribute=attributes[attributeIndex];if(node.hasAttribute(attribute))node.setAttribute(attribute,target)}node.removeAttribute("data-bundle-ref");node.removeAttribute("data-bundle-mime")}var runtime=parsed.createElement("script");runtime.setAttribute("nonce","${FRAME_RUNTIME_NONCE}");runtime.textContent=${JSON.stringify(FRAME_RUNTIME_SCRIPT)};parsed.head.appendChild(runtime);window.__classappBundleUrls=urls;var output="<!doctype html>"+parsed.documentElement.outerHTML;document.open();document.write(output);document.close()}catch(error){fail(error)}},{once:true});parent.postMessage({type:"classapp:bundle-frame-bootstrap-ready"},"*")})()</script></body></html>`;

export interface BundleFrameResource {
  content_id: string;
  mime: string;
  bytes: ArrayBuffer;
}

export interface BundleFrameLoadMessage {
  type: "classapp:bundle-frame-load";
  html: string;
  resources: BundleFrameResource[];
}

/** Sanitize renderer HTML and leave only validated Bundle resource slots. */
export function secureBundlePageHtml(
  html: string,
  resources: ReadonlyMap<string, { mime: string }>,
): string {
  const document = new DOMParser().parseFromString(html, "text/html");
  for (const element of document.querySelectorAll(
    "base,iframe,frame,object,embed,form,input,button,textarea,select,meta[http-equiv],script:not([data-bundle-ref])",
  )) {
    element.remove();
  }
  for (const element of document.querySelectorAll("*")) {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith("on") || name === "srcdoc" || name === "nonce") {
        element.removeAttribute(attribute.name);
      }
    }
    const reference = element.getAttribute("data-bundle-ref");
    if (reference) {
      const resource = resources.get(reference);
      if (!resource) throw new Error(`Bundle 页面缺少资源 ${reference}`);
      const claimedMime = element.getAttribute("data-bundle-mime");
      if (
        claimedMime &&
        claimedMime.toLowerCase() !== resource.mime.toLowerCase()
      ) {
        throw new Error(`Bundle 资源 ${reference} 的 MIME 不一致`);
      }
      const tag = element.tagName.toLowerCase();
      if (
        tag === "script" &&
        resource.mime !== "text/javascript" &&
        resource.mime !== "application/javascript"
      ) {
        throw new Error(`Bundle 脚本 ${reference} 的类型无效`);
      }
      if (
        tag === "link" &&
        element.getAttribute("rel")?.toLowerCase() === "stylesheet" &&
        resource.mime !== "text/css"
      ) {
        throw new Error(`Bundle 样式 ${reference} 的类型无效`);
      }
      let rewritten = false;
      for (const attribute of ["href", "src", "xlink:href"] as const) {
        if (!element.hasAttribute(attribute)) continue;
        element.setAttribute(attribute, "#");
        rewritten = true;
      }
      if (!rewritten) throw new Error(`Bundle 资源 ${reference} 没有载入点`);
    }
    element.removeAttribute("srcset");
    for (const attribute of ["href", "src", "xlink:href", "poster"] as const) {
      const value = element.getAttribute(attribute);
      if (value && !value.startsWith("#") && !value.startsWith("blob:")) {
        element.removeAttribute(attribute);
      }
    }
  }
  const csp = document.createElement("meta");
  csp.httpEquiv = "Content-Security-Policy";
  csp.content = BUNDLE_FRAME_CSP;
  document.head.prepend(csp);
  return `<!doctype html>${document.documentElement.outerHTML}`;
}
