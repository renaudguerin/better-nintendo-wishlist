(function(){"use strict";if(!/^\/my\/wishlist\/?$/.test(window.location.pathname))return;const J="nwm:request",Q="nwm:response",b="nwm_shop_id",K=6e4,f=50,I=100,$=3,X=new Set(["US","GB","JP"]);let h=null,p=null,u=null;const Z=`
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
  `,Y=`
    mutation UseRemoveWishlistWithSession(
      $shopId: Int!
      $country: CountryCode!
      $language: LanguageCode!
      $idToken: String!
      $nsUid: NsUid!
    ) @inContext(shopId: $shopId, country: $country, language: $language) {
      wishlistDeleteV2(idToken: $idToken, nsUid: $nsUid)
    }
  `;if(window.__nwmBridgeInstalled)return;window.__nwmBridgeInstalled=!0;const y=window.fetch.bind(window);function tt(t){if(typeof t!="string")return null;try{return JSON.parse(t)}catch{return null}}function S(t,e,n){document.dispatchEvent(new CustomEvent(Q,{detail:JSON.stringify({requestId:t,ok:e,data:e?n:void 0,error:e?void 0:n})}))}function et(t){const e=String(t??"").trim();if(!/^\d+$/.test(e))throw new Error("Invalid wishlist item ID");return e}function P(t,e,n,r){if(t===void 0)return r;if(!Number.isInteger(t)||t<1||t>n)throw new Error(`${e} must be an integer from 1 to ${n}`);return t}function C(t){if(!t||typeof t!="object"||Array.isArray(t))throw new Error("Resolver payload must be an object");if(!Array.isArray(t.countries)||t.countries.length<1||t.countries.length>$)throw new Error(`Resolver countries must contain 1 to ${$} entries`);const e=[],n=new Set;for(const s of t.countries){if(typeof s!="string"||!X.has(s))throw new Error("Resolver country must be one of: US, GB, JP");if(n.has(s))throw new Error(`Resolver countries contains duplicate country: ${s}`);n.add(s),e.push(s)}const r=t.pagination===void 0?{}:t.pagination;if(!r||typeof r!="object"||Array.isArray(r))throw new Error("Resolver pagination must be an object");return{countries:e,limit:P(r.limit,"Resolver pagination.limit",I,I),maxPages:P(r.maxPages,"Resolver pagination.maxPages",f,f)}}function nt(t){const e=Number(t);if(!Number.isSafeInteger(e))throw new Error("Invalid wishlist item ID");return e}async function rt(t,e){const n=await y(t,{credentials:"include",...e});if(!n.ok){let r="";try{r=await n.text()}catch{}const s=r?`: ${r.slice(0,500)}`:"";throw new Error(`HTTP ${n.status}${s}`)}return n.json()}function st(){const t=document.documentElement&&document.documentElement.innerHTML;return String(t||"").replace(/&quot;/g,'"').replace(/&#x27;/g,"'").replace(/\\"/g,'"').replace(/\\\//g,"/").replace(/\\u0026/g,"&")}function g(t,e){for(const n of e){const r=t.match(n);if(r)return r}return null}function x(t){if(typeof t!="string")return!1;const e=t.match(/^https:\/\/([^/?#]+)/i);if(!e||e[1].includes("@")||/:\d*$/.test(e[1]))return!1;try{const n=new URL(t),r=n.hostname.toLowerCase(),s=r.endsWith(".nintendo.net")||r.endsWith(".nintendo.com");return n.protocol==="https:"&&n.port===""&&s&&n.pathname==="/graphql"}catch{return!1}}function ot(t){const e=g(t,[/"locale"\s*:\s*\{[^}]*"country"\s*:\s*"([A-Z]{2})"[^}]*"language"\s*:\s*"([a-z]{2})"/,/"country"\s*:\s*"([A-Z]{2})"[^}]{0,160}"language"\s*:\s*"([a-z]{2})"/]);if(e)return{country:e[1],language:e[2]};const n=document.querySelector('a[href*="/titles/"], a[href*="/aocs/"], a[href*="/bundles/"]');if(n){const r=n.href.match(/\/([A-Z]{2})\/([a-z]{2})\/(?:titles|aocs|bundles)\//);if(r)return{country:r[1],language:r[2]}}return null}function it(){try{const t=sessionStorage.getItem(b),e=t&&/^\d+$/.test(t)?Number(t):null;if(Number.isSafeInteger(e)&&e>0)return e}catch{}return null}function O(t){try{sessionStorage.setItem(b,String(t))}catch{}}async function at(){const t=it();if(t)return t;const e=[...document.scripts].map(n=>n.src).filter(n=>n&&n.includes("/_next/static/chunks/"));for(const n of e)try{const r=await y(n,{credentials:"include"});if(!r.ok)continue;const o=(await r.text()).match(/["']SHOP_ID["']\s*,\s*0\s*,\s*(\d+)/);if(o){const i=Number(o[1]);return O(i),i}}catch{}return null}async function ct(){if(h)return h;const t=st(),e=g(t,[/"url"\s*:\s*"(https?:\/\/[^"]+\/graphql)"/,/\burl\s*:\s*"(https?:\/\/[^"]+\/graphql)"/]),n=g(t,[/"X-Nintendo-Savanna-Client-Id"\s*:\s*"([^"]+)"/i,/"x-nintendo-savanna-client-id"\s*:\s*"([^"]+)"/i]),r=g(t,[/"shopId"\s*:\s*(\d+)/,/\bshopId\s*:\s*(\d+)/]),s=r?Number(r[1]):await at(),o=ot(t),i=[];if((!e||!x(e[1]))&&i.push("GraphQL URL"),n||i.push("Savanna client id"),s||i.push("shopId"),o||i.push("locale"),i.length>0)throw new Error(`Nintendo GraphQL config not found in page data: ${i.join(", ")}`);return O(s),h={url:e[1],clientId:n[1],shopId:s,locale:o},h}function E(){return p||(p=ct().catch(t=>{throw p=null,t})),p}async function ut(t,e){const n=await E();let r;try{r=await y(n.url,{method:"POST",credentials:"omit",cache:"no-store",headers:{"content-type":"application/json","x-nintendo-savanna-client-id":n.clientId},body:JSON.stringify({operationName:ft(t),query:t,variables:e})})}catch(o){const i=o instanceof Error?o.message:String(o);throw new Error(`GraphQL fetch failed: ${i}`)}if(!r.ok){let o="";try{o=await r.text()}catch{}const i=o?`: ${o.slice(0,500)}`:"";throw new Error(`HTTP ${r.status}${i}`)}const s=await r.json();if(Array.isArray(s.errors)&&s.errors.length>0)throw A(s.errors);return s.data}function U(t,e){if(t==null)return!1;const n=String(e||"").replace(/[^a-z0-9]/gi,"").toLowerCase();if(typeof t=="string"){const r=t.toUpperCase();if(r==="9001-1620"||r==="INVALID_ID_TOKEN"||r==="ID_TOKEN_EXPIRED"||r==="EXPIRED_ID_TOKEN"||/id[\s_-]*token/i.test(t)&&/invalid|expired/i.test(t)||n.includes("idtoken")&&/invalid|expired/i.test(t))return!0}return t===!0&&n.includes("idtoken")&&(n.includes("invalid")||n.includes("expired"))?!0:typeof t=="object"?Object.entries(t).some(([r,s])=>U(s,r)):!1}function R(t){return Array.isArray(t)&&t.some(e=>e&&(/(^|\D)9001-1620(\D|$)/.test(String(e.message||""))||U(e.extensions,"extensions")))}function A(t){const e=new Error(lt(t));return e.name="GraphqlResponseError",e.authRejected=R(t),e}function lt(t){const e=t[0]||{},n=e.message||"GraphQL request failed";if(!e.extensions)return n;let r="";try{r=JSON.stringify(e.extensions).slice(0,500)}catch{r=String(e.extensions).slice(0,500)}return r?`${n}: ${r}`:n}function ft(t){const e=t.match(/\b(query|mutation)\s+([A-Za-z0-9_]+)/);return e?e[2]:void 0}function D(t){if(typeof t!="string")return null;const e=t.split(".");if(e.length!==3||!/^[A-Za-z0-9_-]+={0,2}$/.test(e[1]))return null;const n=e[1].replace(/-/g,"+").replace(/_/g,"/");if(n.length%4===1)return null;const r=n+"=".repeat((4-n.length%4)%4);try{const s=JSON.parse(atob(r));return s&&typeof s.exp=="number"&&Number.isFinite(s.exp)?s.exp:null}catch{return null}}function k(t,e){const n=D(t),r=Number.isFinite(e)?e:Date.now();return n==null||n*1e3<=r+K}function m(){u=null}async function T(){if(u&&!k(u))return u;m();const t=await rt("/api/auth/session");if(!t||!t.idToken)throw new Error("Missing Nintendo session idToken");return u=t.idToken,u}async function q(t){const e=await T();try{return await t(e)}catch(n){if(!n||n.authRejected!==!0)throw n;m();const r=await T();try{return await t(r)}catch(s){throw s&&s.authRejected===!0&&m(),s}}}function L(t,e){return q(n=>ut(t,{...e,idToken:n}))}function M(t){return t?{rawValue:t.rawValue,formattedValue:t.formattedValue,currency:t.currency}:null}function dt(t){const e={};for(const n of["offdevice","hac","bee"]){const r=ht(t,n);r!==null&&(e[n]=r)}return e}function G(t){const e=String(t&&t.nsUid?t.nsUid:""),n=t&&t.itemV2,r=t&&t.price;return e?{id:e,createdAt:t.createdDatetime||"",item:n?{nsUid:String(n.nsUid==null?"":n.nsUid),type:n.__typename,name:n.formalName||"",platformCode:n.labelPlatform||"",imageUrl:n.heroBannerUrl||"",releaseDate:n.releaseDateOnEshop||"",isSpecialTrial:!!n.isSpecialTrial}:null,price:r?{regular:M(r.regularPrice),sale:M(r.discountPrice),saleEndAt:r.discountPrice&&r.discountPrice.endDatetime||null,statuses:dt(r.itemStatuses),owned:!!(r.right&&r.right.isSelfOwned)}:null}:null}function ht(t,e){const n=t&&t[e]&&t[e].salesStatus;return typeof n=="string"&&n.trim()?n.trim():null}function V(t){const e=t.rawItemCount,n=t.newItemCount,r=t.loadedCount,s=t.reportedTotal,o=t.pageCount,i=t.limit,d=Math.ceil(Math.max(0,s)/i)+2,l=Number.isInteger(t.maxPages)?t.maxPages:f,c=Math.min(f,l,d);return e===0?{stop:!0,partial:r<s,reason:"empty-page"}:n===0?{stop:!0,partial:!0,reason:"no-new-items"}:t.hasForwardProgress?r>=s?{stop:!0,partial:!1,reason:"complete"}:o>=c?{stop:!0,partial:!0,reason:"page-cap"}:{stop:!1,partial:!1,reason:null}:{stop:!0,partial:!0,reason:"no-forward-progress"}}function v(t,e,n){let r=0;for(const s of t){const o=G(s);!o||e.has(o.id)||(e.add(o.id),n.push(o),r++)}return r}async function W(t){const e=await E(),n=t||{},r=[],s=new Set,o=Number.isInteger(n.limit)?n.limit:I,i=Number.isInteger(n.maxPages)?n.maxPages:f,d=typeof n.country=="string"?n.country:e.locale.country;let l=0,c=0,N=0,B=!1,_=null;for(;N<i;){const w=await L(Z,{shopId:e.shopId,country:d,language:e.locale.language,offset:l,limit:o}),a=w&&w.account&&w.account.wishlist&&w.account.wishlist.wishlistItems;if(!a)throw new Error("Unexpected wishlist GraphQL response");const H=Array.isArray(a.items)?a.items:[],F=a.offsetInfo&&Number.isFinite(a.offsetInfo.offset)?a.offsetInfo.offset:l,gt=_==null||F>_;_=F,N++;const mt=v(H,s,r);c=a.offsetInfo&&Number.isFinite(a.offsetInfo.total)?a.offsetInfo.total:r.length;const wt=l+o,z=V({rawItemCount:H.length,newItemCount:mt,hasForwardProgress:gt,loadedCount:r.length,reportedTotal:c,pageCount:N,limit:o,maxPages:i});if(z.stop){B=z.partial;break}l=wt}if(r.length===0&&c>0)throw new Error(`Wishlist load returned 0 of ${c} reported items`);return{version:2,items:r,total:c,partial:B,context:{country:d,language:e.locale.language}}}async function j(t){const e=C(t),n=[];for(const r of e.countries)try{n.push({country:r,ok:!0,data:await W({country:r,limit:e.limit,maxPages:e.maxPages})})}catch{n.push({country:r,ok:!1})}return{version:1,results:n}}const pt={getWishlistData:async function(){return W()},resolveWishlistCountries:async function(t){return j(t)},deleteWishlistItem:async function(t){const e=et(t&&t.id),n=await E();return await L(Y,{shopId:n.shopId,country:n.locale.country,language:n.locale.language,nsUid:nt(e)}),{ok:!0}},ping:async function(){return{ok:!0}}};globalThis.__NWM_TEST__&&(globalThis.NWMBridgeTest=Object.freeze({isValidGraphqlUrl:x,parseJwtExp:D,shouldRefreshIdToken:k,getPaginationProgress:V,toEuropeTransportItem:G,appendNewTransportItems:v,isAuthRejectedGraphqlErrors:R,createGraphqlResponseError:A,getIdToken:T,invalidateIdTokenCache:m,withIdTokenRetry:q,validateResolverRequest:C,fetchResolverCountries:j})),document.addEventListener(J,async function(t){const e=tt(t.detail);if(!e||typeof e.requestId!="string"||typeof e.action!="string")return;const n=pt[e.action];if(!n){S(e.requestId,!1,`Unsupported bridge action: ${e.action}`);return}try{const r=await n(e.payload||{});S(e.requestId,!0,r)}catch(r){const s=r instanceof Error?r.message:String(r);S(e.requestId,!1,s)}})})();
