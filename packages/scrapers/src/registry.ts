import type { ShelterAdapter } from "./adapter.js"
import { tozjaworAdapter } from "./adapters/tozjawor.js"
import { lpgkLegnicaAdapter } from "./adapters/lpgk-legnica.js"
import { schroniskoWroclawAdapter } from "./adapters/schronisko-wroclaw.js"
import { schroniskoWalbrzychAdapter } from "./adapters/schronisko-walbrzych.js"
import { schroniskoJeleniaGoraAdapter } from "./adapters/schronisko-jelenia-gora.js"
import { schroniskoDluzynaGornaAdapter } from "./adapters/schronisko-dluzyna-gorna.js"
import { schroniskoSwidnicaAdapter } from "./adapters/schronisko-swidnica.js"
import { fundacjaTaraAdapter } from "./adapters/fundacja-tara.js"
import { centaurusFolwarkAdapter } from "./adapters/centaurus-folwark.js"
import { zoodoptujLatkaNaLapceAdapter } from "./adapters/zoodoptuj-latka-na-lapce.js"
import { fundacjaKubusiaPuchatkaAdapter } from "./adapters/fundacja-kubusia-puchatka.js"
import { schroniskoPoznanAdapter } from "./adapters/schronisko-poznan.js"
import { schroniskoSkalowoAdapter } from "./adapters/schronisko-skalowo.js"
import { schroniskoKrotoszynAdapter } from "./adapters/schronisko-krotoszyn.js"
import { schroniskoKoninAdapter } from "./adapters/schronisko-konin.js"
import { schroniskoPilaMiluszkowAdapter } from "./adapters/schronisko-pila-miluszkow.js"
import { schroniskoOstrowAdapter } from "./adapters/schronisko-ostrow.js"
import { schroniskoWrzesniaPsijacielAdapter } from "./adapters/schronisko-wrzesnia-psijaciel.js"
import { schroniskoLesznoHenrykowoAdapter } from "./adapters/schronisko-leszno-henrykowo.js"
import { przytuliskoWolsztynAdapter } from "./adapters/przytulisko-wolsztyn.js"
import { przytuliskoUWandyAdapter } from "./adapters/przytulisko-u-wandy.js"
import { otozSompolnoAdapter } from "./adapters/otoz-sompolno.js"
import { fundacjaSterczaceUszyAdapter } from "./adapters/fundacja-sterczace-uszy.js"
import { schroniskoGnieznoAdapter } from "./adapters/schronisko-gniezno.js"
import { schroniskoJedrzejewoAdapter } from "./adapters/schronisko-jedrzejewo.js"
import { schroniskoPaluchuAdapter } from "./adapters/schronisko-paluchu.js"
import { celestyniakiAdapter } from "./adapters/celestyniaki.js"
import { fundacjaAzyluAdapter } from "./adapters/fundacja-azylu-psim-aniol.js"
import { schroniskoKorabiewiceAdapter } from "./adapters/schronisko-korabiewice.js"
import { fundacjaPrzyjacieleBraciAdapter } from "./adapters/fundacja-przyjaciele-braci.js"
import { schroniskoPlockAdapter } from "./adapters/schronisko-plock.js"
import { schroniskoMilanowekAdapter } from "./adapters/schronisko-milanowek.js"

const adapters = new Map<string, ShelterAdapter>()

export const registerAdapter = (adapter: ShelterAdapter): void => {
  adapters.set(adapter.id, adapter)
}

registerAdapter(tozjaworAdapter)
registerAdapter(lpgkLegnicaAdapter)
registerAdapter(schroniskoWroclawAdapter)
registerAdapter(schroniskoWalbrzychAdapter)
registerAdapter(schroniskoJeleniaGoraAdapter)
registerAdapter(schroniskoDluzynaGornaAdapter)
registerAdapter(schroniskoSwidnicaAdapter)
registerAdapter(fundacjaTaraAdapter)
registerAdapter(centaurusFolwarkAdapter)
registerAdapter(zoodoptujLatkaNaLapceAdapter)
registerAdapter(fundacjaKubusiaPuchatkaAdapter)
registerAdapter(schroniskoPoznanAdapter)
registerAdapter(schroniskoSkalowoAdapter)
registerAdapter(schroniskoGnieznoAdapter)
registerAdapter(schroniskoJedrzejewoAdapter)
registerAdapter(schroniskoKrotoszynAdapter)
registerAdapter(schroniskoKoninAdapter)
registerAdapter(schroniskoPilaMiluszkowAdapter)
registerAdapter(schroniskoOstrowAdapter)
registerAdapter(schroniskoWrzesniaPsijacielAdapter)
registerAdapter(schroniskoLesznoHenrykowoAdapter)
registerAdapter(przytuliskoWolsztynAdapter)
registerAdapter(przytuliskoUWandyAdapter)
registerAdapter(otozSompolnoAdapter)
registerAdapter(fundacjaSterczaceUszyAdapter)
registerAdapter(schroniskoPaluchuAdapter)
registerAdapter(celestyniakiAdapter)
registerAdapter(fundacjaAzyluAdapter)
registerAdapter(schroniskoKorabiewiceAdapter)
registerAdapter(fundacjaPrzyjacieleBraciAdapter)
registerAdapter(schroniskoPlockAdapter)
registerAdapter(schroniskoMilanowekAdapter)

export const getAdapter = (id: string): ShelterAdapter | undefined => {
  return adapters.get(id)
}

export const getAllAdapters = (): readonly ShelterAdapter[] => {
  return Array.from(adapters.values())
}

export const listAdapters = (): readonly { id: string; name: string }[] => {
  return Array.from(adapters.values()).map((a) => ({ id: a.id, name: a.name }))
}
