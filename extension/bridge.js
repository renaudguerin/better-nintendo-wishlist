(function(){"use strict";if(!/^\/my\/wishlist\/?$/.test(window.location.pathname))return;const k="nwm:request",q="nwm:response",V=3,L=6e4,f=50,I=100,b=3,j=new Set(["US","GB","JP"]);let p=null;const v="Your Nintendo session has expired. Reload this page, then try again.";let u=null;const G=`
    query InfiniteScrollWishlist(
      $shopId: Int!
      $country: CountryCode!
      $language: LanguageCode!
      $idToken: String!
      $offset: Int!
      $limit: Int!
    ) @inContext(shopId: $shopId, country: $country, language: $language) {
      account {
        wishlist {
          wishlistItems(idToken: $idToken, offset: $offset, limit: $limit) {
            items {
              nsUid
              createdDatetime
              itemV2 {
                __typename
                ... on ApplicationItem {
                  nsUid
                  formalName
                  labelPlatform
                  heroBannerUrl
                  releaseDateOnEshop
                  isSpecialTrial
                  demoItems { nsUid }
                }
                ... on DlcItem {
                  nsUid
                  formalName
                  labelPlatform
                  heroBannerUrl
                  releaseDateOnEshop
                }
                ... on BundleItem {
                  nsUid
                  formalName
                  labelPlatform
                  heroBannerUrl
                  releaseDateOnEshop
                }
              }
              price(idToken: $idToken) {
                nsUid
                right {
                  isSelfOwned
                  ownedItems {
                    isSelfOwned
                    isScheduledOrdered
                  }
                }
                regularPrice {
                  formattedValue
                  rawValue
                  currency
                }
                discountPrice {
                  formattedValue
                  rawValue
                  endDatetime
                  currency
                }
                itemStatuses {
                  offdevice { salesStatus }
                  hac { salesStatus }
                  bee { salesStatus }
                }
              }
            }
            offsetInfo {
              offset
              total
            }
          }
        }
      }
    }
  `,M=`
    mutation UseRemoveWishlistWithSession(
      $shopId: Int!
      $country: CountryCode!
      $language: LanguageCode!
      $idToken: String!
      $nsUid: NsUid!
    ) @inContext(shopId: $shopId, country: $country, language: $language) {
      wishlistDeleteV2(idToken: $idToken, nsUid: $nsUid)
    }
  `;if(window.__nwmBridgeInstalled)return;window.__nwmBridgeInstalled=!0;const R=window.fetch.bind(window);function B(e){if(typeof e!="string")return null;try{return JSON.parse(e)}catch{return null}}function y(e,t,n,r=!1){document.dispatchEvent(new CustomEvent(q,{detail:JSON.stringify({requestId:e,ok:t,data:t?n:void 0,error:t?void 0:n,authRejected:r?!0:void 0})}))}function W(e){const t=String(e??"").trim();if(!/^\d+$/.test(t))throw new Error("Invalid wishlist item ID");return t}function P(e,t,n,r){if(e===void 0)return r;if(!Number.isInteger(e)||e<1||e>n)throw new Error(`${t} must be an integer from 1 to ${n}`);return e}function J(e){if(!e||typeof e!="object"||Array.isArray(e))throw new Error("Resolver payload must be an object");if(!Array.isArray(e.countries)||e.countries.length<1||e.countries.length>b)throw new Error(`Resolver countries must contain 1 to ${b} entries`);const t=[],n=new Set;for(const s of e.countries){if(typeof s!="string"||!j.has(s))throw new Error("Resolver country must be one of: US, GB, JP");if(n.has(s))throw new Error(`Resolver countries contains duplicate country: ${s}`);n.add(s),t.push(s)}const r=e.pagination===void 0?{}:e.pagination;if(!r||typeof r!="object"||Array.isArray(r))throw new Error("Resolver pagination must be an object");return{countries:t,limit:P(r.limit,"Resolver pagination.limit",I,I),maxPages:P(r.maxPages,"Resolver pagination.maxPages",f,f)}}function H(e){const t=Number(e);if(!Number.isSafeInteger(t))throw new Error("Invalid wishlist item ID");return t}async function F(e,t){const n=await R(e,{credentials:"include",...t});if(!n.ok){let r="";try{r=await n.text()}catch{}const s=r?`: ${r.slice(0,500)}`:"";throw new Error(`HTTP ${n.status}${s}`)}return n.json()}function z(){const e=document.documentElement&&document.documentElement.innerHTML;return String(e||"").replace(/&quot;/g,'"').replace(/&#x27;/g,"'").replace(/\\"/g,'"').replace(/\\\//g,"/").replace(/\\u0026/g,"&")}function m(e,t){for(const n of t){const r=e.match(n);if(r)return r}return null}function X(e){if(typeof e!="string")return!1;const t=e.match(/^https:\/\/([^/?#]+)/i);if(!t||t[1].includes("@")||/:\d*$/.test(t[1]))return!1;try{const n=new URL(e),r=n.hostname.toLowerCase(),s=r.endsWith(".nintendo.net")||r.endsWith(".nintendo.com");return n.protocol==="https:"&&n.port===""&&s&&n.pathname==="/graphql"}catch{return!1}}function Q(e){const t=m(e,[/"locale"\s*:\s*\{[^}]*"country"\s*:\s*"([A-Z]{2})"[^}]*"language"\s*:\s*"([a-z]{2})"/,/"country"\s*:\s*"([A-Z]{2})"[^}]{0,160}"language"\s*:\s*"([a-z]{2})"/]);if(t)return{country:t[1],language:t[2]};const n=document.querySelector('a[href*="/titles/"], a[href*="/aocs/"], a[href*="/bundles/"]');if(n){const r=n.href.match(/\/([A-Z]{2})\/([a-z]{2})\/(?:titles|aocs|bundles)\//);if(r)return{country:r[1],language:r[2]}}return null}function E(){if(p)return p;const e=z(),t=m(e,[/"url"\s*:\s*"(https?:\/\/[^"]+\/graphql)"/,/\burl\s*:\s*"(https?:\/\/[^"]+\/graphql)"/]),n=m(e,[/"X-Nintendo-Savanna-Client-Id"\s*:\s*"([^"]+)"/i,/"x-nintendo-savanna-client-id"\s*:\s*"([^"]+)"/i]),r=m(e,[/"shopId"\s*:\s*(\d+)/,/\bshopId\s*:\s*(\d+)/]),s=r?Number(r[1]):V,o=Q(e),i=[];if((!t||!X(t[1]))&&i.push("GraphQL URL"),n||i.push("Savanna client id"),(!Number.isSafeInteger(s)||s<=0)&&i.push("shopId"),o||i.push("locale"),i.length>0)throw new Error(`Nintendo GraphQL config not found in page data: ${i.join(", ")}`);return p={url:t[1],clientId:n[1],shopId:s,locale:o},p}async function $(e,t){const n=E();let r;try{r=await R(n.url,{method:"POST",credentials:"omit",cache:"no-store",headers:{"content-type":"application/json","x-nintendo-savanna-client-id":n.clientId},body:JSON.stringify({operationName:ee(e),query:e,variables:t})})}catch(o){const i=o instanceof Error?o.message:String(o);throw new Error(`GraphQL fetch failed: ${i}`)}if(!r.ok){let o="";try{o=await r.text()}catch{}const i=o?`: ${o.slice(0,500)}`:"";throw new Error(`HTTP ${r.status}${i}`)}const s=await r.json();if(Array.isArray(s.errors)&&s.errors.length>0)throw Z(s.errors);return s.data}function _(e,t){if(e==null)return!1;const n=String(t||"").replace(/[^a-z0-9]/gi,"").toLowerCase();if(typeof e=="string"){const r=e.toUpperCase();if(r==="9001-1620"||r==="INVALID_ID_TOKEN"||r==="ID_TOKEN_EXPIRED"||r==="EXPIRED_ID_TOKEN"||/id[\s_-]*token/i.test(e)&&/invalid|expired/i.test(e)||n.includes("idtoken")&&/invalid|expired/i.test(e))return!0}return e===!0&&n.includes("idtoken")&&(n.includes("invalid")||n.includes("expired"))?!0:typeof e=="object"?Object.entries(e).some(([r,s])=>_(s,r)):!1}function x(e){const t=e&&e.extensions;return!!t&&t.module==="NAS"&&(t.title==="JWT_HAS_EXPIRED"||String(t.errorCode)==="9712")}function K(e){return Array.isArray(e)&&e.some(t=>t&&(x(t)||/(^|\D)9001-1620(\D|$)/.test(String(t.message||""))||_(t.extensions,"extensions")))}function Z(e){const t=new Error(Y(e));return t.name="GraphqlResponseError",t.authRejected=K(e),t.rejectedBeforeExecution=e.length>0&&e.every(x),t}function Y(e){const t=e[0]||{},n=t.message||"GraphQL request failed";if(!t.extensions)return n;let r="";try{r=JSON.stringify(t.extensions).slice(0,500)}catch{r=String(t.extensions).slice(0,500)}return r?`${n}: ${r}`:n}function ee(e){const t=e.match(/\b(query|mutation)\s+([A-Za-z0-9_]+)/);return t?t[2]:void 0}function te(e){if(typeof e!="string")return null;const t=e.split(".");if(t.length!==3||!/^[A-Za-z0-9_-]+={0,2}$/.test(t[1]))return null;const n=t[1].replace(/-/g,"+").replace(/_/g,"/");if(n.length%4===1)return null;const r=n+"=".repeat((4-n.length%4)%4);try{const s=JSON.parse(atob(r));return s&&typeof s.exp=="number"&&Number.isFinite(s.exp)?s.exp:null}catch{return null}}function ne(e,t){const n=te(e),r=Number.isFinite(t)?t:Date.now();return n==null||n*1e3<=r+L}function d(){u=null}async function g(){if(u&&!ne(u))return u;d();const e=await F("/api/auth/session");if(!e||!e.idToken)throw new Error("Missing Nintendo session idToken");return u=e.idToken,u}async function re(e){const t=await g();try{return await e(t)}catch(n){if(!n||n.authRejected!==!0)throw n;d();const r=await g();try{return await e(r)}catch(s){throw s&&s.authRejected===!0&&d(),s}}}function se(e,t){return re(n=>$(e,{...t,idToken:n}))}function A(e){return e?{rawValue:e.rawValue,formattedValue:e.formattedValue,currency:e.currency}:null}function oe(e){const t={};for(const n of["offdevice","hac","bee"]){const r=ce(e,n);r!==null&&(t[n]=r)}return t}function ie(e){return e.__typename!=="ApplicationItem"||!Array.isArray(e.demoItems)?null:e.demoItems.length===0?!1:e.demoItems.some(n=>{const r=n==null?void 0:n.nsUid;return(typeof r=="number"||typeof r=="string")&&/^7003\d{10}$/.test(String(r))})?!0:null}function ae(e){const t=String(e&&e.nsUid?e.nsUid:""),n=e&&e.itemV2,r=e&&e.price;return t?{id:t,createdAt:e.createdDatetime||"",item:n?{nsUid:String(n.nsUid==null?"":n.nsUid),type:n.__typename,name:n.formalName||"",platformCode:n.labelPlatform||"",imageUrl:n.heroBannerUrl||"",releaseDate:n.releaseDateOnEshop||"",isSpecialTrial:!!n.isSpecialTrial,demoAvailable:ie(n)}:null,price:r?{regular:A(r.regularPrice),sale:A(r.discountPrice),saleEndAt:r.discountPrice&&r.discountPrice.endDatetime||null,statuses:oe(r.itemStatuses),owned:!!(r.right&&r.right.isSelfOwned)}:null}:null}function ce(e,t){const n=e&&e[t]&&e[t].salesStatus;return typeof n=="string"&&n.trim()?n.trim():null}function ue(e){const t=e.rawItemCount,n=e.newItemCount,r=e.loadedCount,s=e.reportedTotal,o=e.pageCount,i=e.limit,h=Math.ceil(Math.max(0,s)/i)+2,l=Number.isInteger(e.maxPages)?e.maxPages:f,c=Math.min(f,l,h);return t===0?{stop:!0,partial:r<s,reason:"empty-page"}:n===0?{stop:!0,partial:!0,reason:"no-new-items"}:e.hasForwardProgress?r>=s?{stop:!0,partial:!1,reason:"complete"}:o>=c?{stop:!0,partial:!0,reason:"page-cap"}:{stop:!1,partial:!1,reason:null}:{stop:!0,partial:!0,reason:"no-forward-progress"}}function le(e,t,n){let r=0;for(const s of e){const o=ae(s);!o||t.has(o.id)||(t.add(o.id),n.push(o),r++)}return r}async function S(e){const t=E(),n=e||{},r=[],s=new Set,o=Number.isInteger(n.limit)?n.limit:I,i=Number.isInteger(n.maxPages)?n.maxPages:f,h=typeof n.country=="string"?n.country:t.locale.country;let l=0,c=0,T=0,D=!1,N=null;for(;T<i;){const w=await se(G,{shopId:t.shopId,country:h,language:t.locale.language,offset:l,limit:o}),a=w&&w.account&&w.account.wishlist&&w.account.wishlist.wishlistItems;if(!a)throw new Error("Unexpected wishlist GraphQL response");const U=Array.isArray(a.items)?a.items:[],C=a.offsetInfo&&Number.isFinite(a.offsetInfo.offset)?a.offsetInfo.offset:l,he=N==null||C>N;N=C,T++;const pe=le(U,s,r);c=a.offsetInfo&&Number.isFinite(a.offsetInfo.total)?a.offsetInfo.total:r.length;const me=l+o,O=ue({rawItemCount:U.length,newItemCount:pe,hasForwardProgress:he,loadedCount:r.length,reportedTotal:c,pageCount:T,limit:o,maxPages:i});if(O.stop){D=O.partial;break}l=me}if(r.length===0&&c>0)throw new Error(`Wishlist load returned 0 of ${c} reported items`);return{version:2,items:r,total:c,partial:D,context:{country:h,language:t.locale.language}}}async function fe(e){const t=J(e),n=[];for(const r of t.countries)try{n.push({country:r,ok:!0,data:await S({country:r,limit:t.limit,maxPages:t.maxPages})})}catch{n.push({country:r,ok:!1})}return{version:1,results:n}}const de={getWishlistData:async function(){return S()},resolveWishlistCountries:async function(e){return fe(e)},deleteWishlistItem:async function(e){const t=W(e&&e.id),n=E(),r=o=>$(M,{shopId:n.shopId,country:n.locale.country,language:n.locale.language,nsUid:H(t),idToken:o});let s;try{try{s=await r(await g())}catch(o){if(!(o&&o.rejectedBeforeExecution===!0))throw o;d(),s=await r(await g())}}catch(o){throw o&&o.authRejected===!0?(d(),new Error(v)):o}if(!s||!Object.prototype.hasOwnProperty.call(s,"wishlistDeleteV2")||s.wishlistDeleteV2===!1)throw new Error("Removal was not confirmed. Reload and check your wishlist before retrying.");if(s.wishlistDeleteV2!==!0){const o=await S();if(o.partial||o.items.some(i=>i.id===t))throw new Error("Removal was not confirmed. Reload and check your wishlist before retrying.")}return{ok:!0}},ping:async function(){return{ok:!0}}};document.addEventListener(k,async function(e){const t=B(e.detail);if(!t||typeof t.requestId!="string"||typeof t.action!="string")return;const n=de[t.action];if(!n){y(t.requestId,!1,`Unsupported bridge action: ${t.action}`);return}try{const r=await n(t.payload||{});y(t.requestId,!0,r)}catch(r){const s=r instanceof Error?r.message:String(r);y(t.requestId,!1,s,(r==null?void 0:r.authRejected)===!0)}})})();
