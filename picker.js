// Runs inside VS Code's SCM input widget; services and observables are supplied by install.py.
function scmToolkitHideOutgoingSyncCount(widget) {
    const root = widget.element.closest('.scm-view');
    const Observer = widget.element.ownerDocument.defaultView?.MutationObserver;
    if (!root || !Observer) return;

    const observedRoots = globalThis.__scmToolkitOutgoingSyncRoots ??= new WeakSet();
    if (observedRoots.has(root)) return;
    observedRoots.add(root);

    const update = () => {
        for (const action of root.querySelectorAll('.button-container .monaco-button')) {
            if (!action.querySelector('.codicon-sync')) continue;

            for (const upArrow of action.querySelectorAll(
                '.monaco-button-label > .codicon-arrow-up, '
                + '.monaco-button-label-short > .codicon-arrow-up'
            )) {
                const count = upArrow.previousElementSibling;
                if (!count || count.classList.contains('codicon')) continue;

                const text = count.textContent ?? '';
                const withoutOutgoingCount = text.replace(/\s*\d+\s*$/, '').trimEnd();
                if (withoutOutgoingCount === text) continue;

                count.textContent = withoutOutgoingCount;
                count.hidden = withoutOutgoingCount.trim() === '';
            }
        }
    };

    update();
    const observer = new Observer(update);
    observer.observe(root, { subtree: true, childList: true, characterData: true });
}

async function scmToolkitPullCleanRepository(provider, commands, repositoryArgument) {
    const hasChanges = () => provider.groups.some(group => group.resources.length > 0);
    if (hasChanges()) return false;

    const historyProvider = provider.historyProvider.get();
    const localRef = historyProvider?.historyItemRef.get();
    const remoteRef = historyProvider?.historyItemRemoteRef.get();
    if (
        !historyProvider
        || !localRef?.id
        || !localRef.revision
        || !remoteRef?.id
        || !remoteRef.revision
        || localRef.revision === remoteRef.revision
    ) {
        return false;
    }

    const ancestor = await historyProvider.resolveHistoryItemRefsCommonAncestor([
        localRef.id,
        remoteRef.id
    ]);
    if (ancestor !== localRef.revision || hasChanges()) return false;

    const currentLocalRef = historyProvider.historyItemRef.get();
    const currentRemoteRef = historyProvider.historyItemRemoteRef.get();
    if (
        currentLocalRef?.revision !== localRef.revision
        || currentRemoteRef?.revision !== remoteRef.revision
        || hasChanges()
    ) {
        return false;
    }

    await commands.executeCommand('git.pull', repositoryArgument);
    return true;
}

function scmToolkitEnableBlankStateRefresh(
    widget,
    input,
    commands,
    repositoryArgument,
    autoPullClean
) {
    const doc = widget.element.ownerDocument;
    const win = doc.defaultView;
    const provider = input.repository.provider;
    if (!win || !repositoryArgument || typeof provider.onDidChangeResources !== 'function') return;

    let timer;
    let refreshing = false;
    let disposed = false;
    let lastAutoPullState;
    const progressRoot = widget.element.closest('.scm-view')?.parentElement;

    const hasChanges = () => provider.groups.some(group => group.resources.length > 0);

    const clearTimer = () => {
        if (timer === undefined) return;
        win.clearTimeout(timer);
        timer = undefined;
    };

    const maybeAutoPull = async () => {
        if (!autoPullClean || hasChanges()) return;

        const historyProvider = provider.historyProvider.get();
        const localRef = historyProvider?.historyItemRef.get();
        const remoteRef = historyProvider?.historyItemRemoteRef.get();
        if (!localRef?.revision || !remoteRef?.revision || localRef.revision === remoteRef.revision) {
            return;
        }

        const state = `${localRef.revision}:${remoteRef.revision}`;
        if (state === lastAutoPullState) return;
        lastAutoPullState = state;

        try {
            await scmToolkitPullCleanRepository(provider, commands, repositoryArgument);
        } catch {
            // Keep automatic pulls best-effort; the built-in Git extension owns Git errors.
        }
    };

    const schedule = delay => {
        clearTimer();
        if (disposed || hasChanges()) return;

        timer = win.setTimeout(async () => {
            timer = undefined;
            if (disposed || hasChanges()) return;

            if (doc.hidden) {
                schedule(5000);
                return;
            }

            refreshing = true;
            progressRoot?.classList.add('scm-toolkit-refreshing');
            try {
                await commands.executeCommand('git.refresh', repositoryArgument);
                await maybeAutoPull();
            } catch {
                // The built-in Git extension owns refresh errors; keep blank-state polling best-effort.
            } finally {
                progressRoot?.classList.remove('scm-toolkit-refreshing');
                refreshing = false;
                if (!disposed && !hasChanges()) schedule(1500);
            }
        }, delay);
    };

    const resourceDisposable = provider.onDidChangeResources(() => {
        if (disposed) return;

        if (hasChanges()) {
            clearTimer();
            return;
        }

        if (!refreshing && timer === undefined) schedule(300);
    });

    const onVisibilityChange = () => {
        if (disposed || hasChanges() || doc.hidden) return;
        if (!refreshing && timer === undefined) schedule(300);
    };

    doc.addEventListener('visibilitychange', onVisibilityChange);
    schedule(300);

    return {
        dispose() {
            disposed = true;
            clearTimer();
            progressRoot?.classList.remove('scm-toolkit-refreshing');
            resourceDisposable.dispose();
            doc.removeEventListener('visibilitychange', onVisibilityChange);
        }
    };
}

const SCM_TOOLKIT_CODEX_COAUTHOR = 'Co-authored-by: Codex <noreply@openai.com>';

function scmToolkitWithCodexCoauthor(message) {
    const base = message.trimEnd();
    if (!base) return '';

    const alreadyAttributed = base.split(/\r?\n/).some(
        line => line.trim() === SCM_TOOLKIT_CODEX_COAUTHOR
    );
    return alreadyAttributed ? base : `${base}\n\n${SCM_TOOLKIT_CODEX_COAUTHOR}`;
}

function scmToolkitParseGitHubRemote(remoteUrl) {
    const value = String(remoteUrl ?? '').trim();
    if (!value) return undefined;

    const patterns = [
        /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/i,
        /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i,
        /^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/i,
    ];

    for (const pattern of patterns) {
        const match = value.match(pattern);
        if (match) return { owner: match[1], repo: match[2] };
    }
    return undefined;
}

function scmToolkitPullRequestTitle(branch) {
    const tail = String(branch ?? '').split('/').filter(Boolean).pop() ?? '';
    const words = tail.replace(/[-_]+/g, ' ').trim();
    return words ? words[0].toUpperCase() + words.slice(1) : `Open ${branch}`;
}

function scmToolkitMcpError(result) {
    const message = result?.content?.find(
        item => item?.type === 'text' && typeof item.text === 'string'
    )?.text;
    return message || 'The MCP pull-request tool returned an error.';
}

async function scmToolkitWaitForMcpTool(doc, server, toolName) {
    const win = doc.defaultView;
    for (let attempt = 0; attempt < 50; attempt += 1) {
        const tool = server.tools?.get?.().find(candidate => candidate.definition?.name === toolName);
        if (tool) return tool;
        await new Promise(resolve => win ? win.setTimeout(resolve, 100) : setTimeout(resolve, 100));
    }
    return undefined;
}

// Named G4 pony entries from the full MLP pony roster. Explicitly unnamed placeholders,
// G5 entries, and non-pony kirin are intentionally excluded from this branch-name pool.
const SCM_TOOLKIT_G4_PONY_BRANCH_NAMES = `abradacanter
ace-point
acrylic-paint
adante
admiral-fairweather
admiral-fairy-flight
affero
al-roker
alicorn-royal-guards
aloe
aloha
alphabittle-blossomforth
alt-pony-1derek
alt-pony-2matt
alt-pony-3matt
amaranthine
amberlocks
amelia-airhoof
amethyst-star
ancient-artifact
ancient-beast-dealercratus
angel-wings
announcer-ponymadden
antique-chicken-stand-ponymatch-game
apple-bloom
apple-bottom
apple-bread
apple-brown-betty
apple-bud
apple-bumpkin
apple-bytes
apple-cider
apple-cinnamon
apple-cobbler
apple-core
apple-crumble
apple-dumpling
apple-flora
apple-fritter
apple-honey
apple-leaves
apple-mint
apple-munchies
apple-polish
apple-rose
apple-slice
apple-split
apple-squash
apple-stars
apple-strudel
apple-top
applejack
applejacks-fatherbright-mac
applejacks-motherpear-butter
apricot-bow
aqua-burst
aqua-crystal-foalrock-candy
aquamarine
archer
architecture-ponynorth-point
arctic-lily
argyle-starshine
arpeggio
astro-ponyneptunio
athletic-dancerflashdancer
attendant-ponyginger-locks
audience-ponylemon-lime
aunt-holiday
aunt-orange
auntie-applesauce
auntie-lofty
aura
autumn-gem
autumn-leaf
avalon
b-sharp
babs-seed
bacon-braids
bags-valet
baker-fillytulip-swirl
ballad
banana-fluff
banner-vendorpeachy-pitt
barbara-banter
barber-groomsby
baritone
barley-barrel
barley-grind
bassist-ponygeorge-horrsen
bearded-hollowvianginger-beard
beaude-mane
beauty-brass
bee-bop
beesting
bell-perin
bella-brella
belle-star
bellhopluggage-cart
berry-dreams
berry-frost
berry-icicle
berry-preppy
berry-splash
berryjack
berryshine
betty-hoof
beuford
beyond
biddy-broomtail
big-bell
big-bucks
big-daddy-mccolt
big-haired-bowlerbig-wig
big-mcintosh
big-mouthed-schoolponycarrot-crunch
big-shot
big-stalliontight-end
big-top
biscuit
bitta-blues
bittersweet
black-marble
black-stone
blade-runner
blaze
bloo
blossom-delight
blossomforth
blue-belle
blue-bobbin
blue-bonnet
blue-bows
blue-buck
blue-crystal-foaltiny-topaz
blue-cutie
blue-diamond
blue-emerald
blue-lily
blue-moon
blue-nile
blue-october-blueberry-muffin
bluebell
blueberry-banana
blueberry-cloud
blueberry-curls
blueberry-frosting
blueberry-punch
blueberry-swirl
bluebird-happiness
bluenote
bold-archaeologistindiana-pones
bolt
bon-voyage
bonnie
booksmart
bookstore-pony-1raspberry-latte
bookstore-pony-2minty-mocha
bottlecap
bow-hothoof
bowling-ponywalter
boysenberry
bracer-britches
braeburn
braid-maned-schoolponyrasberry-sic-dazzle
brass-blare
bright-bulb
bright-mac
bright-ponysunshine-smiles
bright-smile
brindle-young
britneigh-spurs
bubblegum-brush
buddy
builder-ponyambrosia
bulk-biceps
bulk-shipment
burdock-hooffield
buried-lede
burning-heart
burning-passion-sic
burnt-oak
bush-league
bushel
business-ponyuptown-clover
business-savvy
butter-pop
butternut
buttershy
buzzard-hooffield
buzzsaw-mccolt
caballerons-bandolerobiff
caballerons-brigandrogue
caballerons-thugwithers
cabbiepronto
caboose
cadet-2meadow-flower
calamity-mane
candy-apples
candy-caramel-tooth
candy-curls
candy-floss
candy-mane
candy-twirl
canterlot-shopkeep-specify
captainblow-dry
caramel
caramel-apple
caramel-coffee
carbon-fizz
carlotta
cascada
castle-guard-2spearhead
cattail
cerise-bud
cerulean-skies
chancellor-neighsay
chancellor-puddinghead
charcoal-bakes
charged-up
charity-kindheart
charlie-coal
charm
check-mate
cheerful-fansweet-pepper
cheerilee
cheery
cheese-curls
cheese-sandwich
chelsea-porcelain
cherry-berry
cherry-fizzy
cherry-gold
cherry-jubilee
cherry-jumble
cherry-punch
cherry-spices
cherry-strudel
chiffon-crystal-foalcoral-shores
chilly-puddle
chimney-dust
chip-mint
chipcutter
chirpy-hooves
choco-cozy
chocolate-blueberry
chocolate-haze
chocolate-sun
chocolate-tail
chummy-friendship-studentberry-bliss
cinnabelle
cinnamon-chai
cinnamon-pear
cinnamon-sugar
cinnamon-swirl
cipher-splash
citrine-spark
classy-clover
claude
clear-skies
clear-sky
cleopatra-jazz
clerkraspberry-vinaigrette
clever-schoolponyboysenberry
cloud-break
cloud-chaser
cloud-kicker
cloud-showers
cloudsdale-cheer-ponylilac-sky
cloudsdale-cheer-ponyspring-step
cloudy-daze
clover-the-clever
cloverbelle
clumsy-clownsponypratfall
cobalt
cobalt-shade
coco-pommel
coconut-cream
code-red
cold-front
colonel-purple-dart
coloratura
coloraturas-stylistlimelight
comb-over
comet-tail
comic-geek-ponysplash-panel
commander-easyglider
commander-hurricane
commander-ironhead
compass-star
conductorall-aboard
confident-friendship-studentsoaring-virtue
cool-beans
cool-gray
coral-bits
coral-shine
coriander-cumin
cormano
cornflower
coronet
cosmic
cotton-candy-coltpapa-beard
cotton-cloudy
cotton-sky
cotton-top
count-caesar
cozy-glow
crackle-pop
crafty-crate
cream-crystal-ponyfleur-de-verre
cream-puff
cream-tangerine
creamcup
creme-brulee
crescendo
crescent-ponymane-moon
crest-crown
crimson-heart
crimson-skate
crosscut-mccolt
cruise-pony-1raspberry-sorbet
cruise-pony-2pony-in-windowsunny-side
cruise-pony-3forceful-parent-ponysun-cloche
crusoe-palm
crystal-beau
crystal-chalice-stand-ponyamethyst-gleam
crystal-clear
crystal-hoof
crystal-varado
cubist-ponypicture-pattern
cultivar
curio-shopkeeperuncle-wing
customer-ponyspring-green
cutting-edge-shop-ponybetsey-trotson
cyan-skies
daisy
dancing-clownsponycaramel
dandy-brush
dandy-grandeur
dane-tee-dove
danny-trottance
dapper-ponyrotten-apple
daring-do
daring-do-collectorteddie-safari
davenport
dazzle-feather
dear-darling
delegate-1neigh-sayer
delivery-ponypackage-deal
demure-ponygolden-harvest
deputy-sprout-cloverleaf
derpy
descent
desert-wind
detective-ponynatural-deduction
determined-shoppercloud-kicker
determined-traineeshort-fuse
dewdrop
diamond-cutter
diamond-mint
diamond-tiara
dignified-shop-ponystarke-kragen
dinky-doo
dipsy
dirtbound
disciplined-traineehyacinth-dawn
discord
dishwater-slog
distant-star
distinguished-waiter-ponyearl-grey
dj-pon-3
doctor-horse
doctor-pinkheart
doctor-ponymodus-ponens
don-neigh
doseydotes
dosie-dough
double-diamond
downdraft
dr-caballeron
dr-fauna
dr-hooves
dr-horse
dr-steth
drizzle
dry-wheat
duce-switchell
duchess-of-maretoniaice-mirror
duke-of-maretoniakyrippos-ii
dumb-bell
dusty-gust
dusty-mccolt
dusty-pages
eager-schoolponytrain-tracks
earnest-schoolponyfirst-base
earth-crystal-pony-royal-guards
earth-pony-royal-guards
eclair-creme
ecstatic-dancerpacific-glow
edler-sic-stallioncortland
eff-stop
eiffel
elbow-grease
electric-blue
electric-sky
elite-ponyponet
eliza
elphaba-trot
emerald-beacon
emerald-green
emt-ponyhermes
end-zone
endless-clouds
esmeralda
evening-star
excitable-villageramethyst-skim
executive-producer-story-editornicole-dubuc
expressive-townsponysunny-song
eyeshade-ponykarat
fahal-alkhayl
fancy-friendship-studentstrawberry-scoop
fancy-pants
fashion-plate
fashionable-ponycitrus-blush
fast-clip
fat-stacks
father-ponymr-paleo
feather-bangs
feather-flatterfly
featherweight
feldspar-granite-pie
felix
fiddly-twang
fiery-fricket
fili-second
filthy-rich
fine-catch
fine-line
finish-line
fire-chiefdinky-doo
fire-flare
fire-streak
firelight
firelock
first-base
first-folio
flair-dmare
flam
flank-sinatra
flash-magnus
flash-sentry
flashy-ponydance-fever
fleetfoot
fleur-de-lis
flim
flitter
floral-pan
florina-tart
flounder
flower-flight
flurry
flurry-heart
flutterholly
fluttershy
fluttershys-fathermr-shy
fluttershys-mothermrs-shy
fly-wishes
foggy-fleece
food-merchantchock-full-carafe
forest-spirit
formalwear-coltstrike
four-step
foxxy-trot
frantic-photographercrackle-cosette
frederick-horseshoepin
free-throw
fresh-coat
frou-frou
fruitbasket
fuchsia-fizz
fuchsia-gems
full-steam
fun-loving-traineefeather-twirl
funnel-web
furniture-salesponywooden-legs
future-apple-foalbig-sugar
fuzzy-slippers
gala-appleby
gallop-j-fry
game-playin-schoolponybutton-mash
gary-coronet
general-blazing-donut-glaze
general-firefly
general-flash
geronimo
ginger-shade
ginger-tea
gingerbread
giza-hafir
gizmo
gladmane
glass-slipper
glitter-spritz
globe-trotter
gold-slipper
golden-delicious
golden-gavel
golden-glitter
golden-glory
golden-harvest
golden-hooves
golden-wheat
goldengrape
goldie-delicious
goldie-fortune
gorgeous-glamour
goth-ponymoonlight-raven
goth-shoppersnow-hope
graceful-falls
grand-pear
grandpa-skies
granny-pie
granny-smith
granny-smiths-fatherpokey-oaks
granny-smiths-mothersew-n-sow
grape-crush
grape-delight
grape-soda
grape-stem
gravedigger-hooffield
green-crystal-ponysilver-medal
green-daze
green-jewel
greenhoof-hooffield
groucho-mark
grub-hooffield
guitarist-ponyliam-t-walrus
gusty-the-great
hacksaw-mccolt
hairpin-turn
half-baked-apple
hammerhead-mccolt
hammerstrike
happy-trails
hard-hat
hard-rock
harry-trotter-dubious-discuss
harsh-critique-dubious-discuss
hay-fever
haymaker
haymish
hayscartes
hayseed-swamp-stallionsavage-honeydew
hayseed-turnip-truck
hazel-harvest
head-chef-ponygourmand-ramsay
hearty-brew
heather-harp
hefty-resortgoerchargrill-breadwinner
heidi-hay
heisenbuck
helia
henchponypickpocket
hercules
hermes
high-note
high-roller
high-spirits
high-winds
hilly-hooffield
hinny-of-the-hills
hoda-kotb
hoity-toity
holder-cobblestone
holly-dash
honey-dew
honey-drop
honey-rays
honeysparkle
hoofar
hoofdini
hoofer-steps
hoops
hope
hors-doeuvre
horseshoe-comet
horticultural-pegasusevergreen
housekeeper-ponytote-bag
huckleberry
hughbert-jellius
hyped-up-dancerazure-velour
icy-drop
icy-rain
imperial-coltcinnamon-tea
impossibly-rich
incidental-ponywhoa-nelly
indigo-crystal-ponygallic
infinity
inky-rose
inquisitive-shopperrainbowshine
iron-bark
isla-breeze
ivory-crystal-ponyivory-rook
jack-hammer
jack-pot
jade
jaded-jasper
janitor-ponyclean-sweep
jazz-hooves
jeff-letrotski
jeff-trotsworthy
jelly-vine
jesus-pezuna
jet-set
jetstream
jeweled-ponyold-money
jeweler-ponyclarity-cut
jim-beam
jinx
joan-pommelway
joe
john-bull
jonagold
jorunn
jubileena
juicy-fruit
junebug
junior-deputystar-spur
juniper-montage
juno
kathie-lee-gifford
kazooie
kerfuffle
kettle-corn
key-lime
king-bullion
king-sombra
klein
knowledgeable-shopperwhite-lightning
lady-beetle
lady-gaval
laid-back-fancarrot-bun
lance
lapis-hauyne
las-pegasus-singerzen-moment
laurette
lavandula
lavender-august
lavender-bloom
lavender-blush
lavender-crystal-ponyamber-laurel
lavender-essence
lavender-fritter
lavender-skies
lavender-sunrise
lavenderhoof
lazy-fanderpy
lead-singer-ponypaul-mccartneigh
leadnail-mccolt
leadwing
lemon-daze
lemon-hearts
lemon-honey
lemon-scratch
lemongrass
lemony-gem
levon-song
liberty-belle
librarianamethyst-maresbury
lickety-split
lighthoof
lightning-dust
lightning-flare
lightning-riff
lightning-streak
lil-cheese
lilac-blossom
lilac-hearts
lilac-links
lilac-luster
lilac-notes
lilly-love
lily-dache
lily-lace
lily-valley
lime-jelly
limestone-pie
lincoln
line-ponycranberry-muffin
linked-hearts
lipstick-vanity
little-match
little-po
little-ponytag-a-long
little-red
little-violet
liza-doolots
locknut-mccolt
log-jam
lolli-love
long-shot
lotus-blossom
love-melody
love-sketch
luckette
lucky-clover
lucky-star
lucy-packard
luster-dawn
lyra-heartstrings
lyrica-lilac
m-c-ponywaxton
ma-hooffield
ma-switchell
magdalena
mage-meadowbrook
magenta-surf
magical-ponycelena
magnet-bolt
mail-ponybrilliant-service
majesty
mama-biceps
mane-allgood
mane-iac
mane-moon
manehattan-delegatejoe-pescolt
manely-gold
mango-dash
mango-juice
maple-cheer
marble-pie
mare-do-well
mare-e-belle
mare-e-lynn
maribelle
maroon-carrot
masked-matter-horn
masked-nurseopen-heart
masked-pony-1hippocratic-oath
masked-pony-2doctor-spring-bud
masseuse-ponyquake
matt-lauer
maud-pie
maybelline
mayor-mare
mayor-of-baltimaremayor-baltimare
mayor-of-fillydelphiamayor-cream-cheese
mccreecassidy-dubious-discuss
meadow-song
meadowbrooks-motherlilac-meadow
meadowluck
melilot
merry
merry-may
messy-stallionpigpen
method-mare-1on-stage
method-mare-2raspberry-beret
method-mare-3late-show
method-mare-4stardom
midnight-fun
midnight-strike
midwinter-grace
mighty-helm-guardsponysun-cross
millie
mind-freak
mint-condition
mint-flower
mint-swirl
mint-tea
minty
minuette
miss-hackney
mistmane
mistmanes-fatherrain-swirl
mistmanes-motherpeaceful-flower
mistress-mare-velous
misty-fly
mixed-berry
mjolna
mocha-berry
monochrome-sunset
moody-root
moon-dancer
moon-dust-dubious-discuss
moonlight-zephyr
morning-glory
morning-roast
morton-saltworthy
mossy-rock
mother-ponymrs-paleo
mountain-haze
mr-breezy
mr-carrot-cake
mr-greenhooves
mr-hoofington
mr-kingpin
mr-pearblossom
mr-stripes
mr-waddle
mr-zippy
mrs-cup-cake
mrs-hoofington
mrs-pearblossom
mrs-trotsworth
ms-harshwhinny
ms-peachbottom
mudbriar
muffins
muggy-air
mulberry-flowers
mules-grassfield
mustache-crystal-ponymustafa-combe
my-little-primeoptimare-prime
nachtmusik
namby-pamby
nana-pinkie
nasal-ponypretzel
natural-satellite
nature-walk
nearsighted-schoolponylittle-red
neighls-bohr
neon-lights
nerdy-delegatefrazzle-rock
newspaper-ponyfine-print
night-glider
night-knight
night-watch
nightingale
nixie
noi
nook
northern-lights
noteworthy
novice-archaeologistdust-brush
nurse-fahrenheit
nurse-magenta-heart
nurse-redheart
nurse-snowheart
nurse-sweetheart
nurse-tenderheart
nursery-rhyme
oak-nut
oakey-doke
obscurity
ocean-breeze
ocean-dream
ocean-sky
ocean-spray
octavia-melody
offbeat
officerquick-trim
ol-salt
old-gardenerlotus-petal
opal-bloom
open-friendship-studentpizzelle
open-skies
opulence
orange-crystal-ponygolden-vas
orange-sherbet
orange-slice
orange-swirl
orchid-dew
oregon-trail
organic-bakercracked-wheat
paisley-pastel
pampered-pearl
parasol
parcel-post
parish-nandermane
party-favor
parula
passionate
peach-fuzz
peach-melba
peachy-cream
peachy-petal
peachy-pie
peachy-plume
peachy-sweet
peanut-pastry
peanut-plant
pear-butter
pearly-stitch
pearly-whites
peduncle-bloom
pegasus-crystal-pony-royal-guards
pegasus-dadnightjar
pegasus-olsen
pegasus-royal-guards
penny-ante
pepper-pot
peppy-resortgoerlemon-chiffon
perceptive-friendship-studentnovember-rain
perfect-pace
perfect-pie
perfect-timing
perfume-hearts
periwinkle-pace
perky-prep
persnickety
personal-shopper-ponytwinkleworks
pest-control-ponyegon
petunia-paleo
petunia-petals
photo-finish
photographer-ponytracy-flash
phyllis-cloverleaf
pickle-barrel
picture-frame
piles-mccolt
pin-ponyscouts-honor
pina-colada
pine-breeze
pink-cloud
pink-crystal-foalcloudy-spinel
pink-drink
pink-maned-fillybrown-sugar
pinkie-feather
pinkie-pie
pinkie-pies-brotheroctavio-pie
pinkie-pies-fatherigneous-rock-pie
pinkies-momcloudy-quartz
pinkies-sisterlimestone-pie
pinkies-sistermarble-pie
pinkies-sistermaud-pie
pinkies-sisterpizza-pie
pinny-lane
pipe-down
pipsqueak
pistachio
pitch-perfect
pixie
plaid-stripes
play-write
plum-crystal-ponyamethyst-shard
plum-star
plumberry
pokerhooves
police-ponydeputy-copper
pomegranate
pone-fantastique-aerialisttrapeze-star
pony-mcmeadow-song
pony-shopperminty-bubblegum
pony-shopperpearmain-worcester
pony-student-3patty-peppermint
pony-vendor-2marey-poppins-dubious-discuss
pony-vendor-3top-notch
poofy-maned-schoolponyblade-runner
pop-art-ponyandy-warhoof
pop-fly
pop-up
poppycock
posey-bloom
posey-petals
posh-ponycayenne
potion-hiss
potion-nova
pouch-ponystreet-rat
pound-cake
powder-puff
powder-rouge
power-chord
prairie-tune
prancent-pega
precious
press-release
pretty-vision
prim-hemline
prim-posy
primrose
prince-blue-dream
prince-blueblood
prince-hisan
princess-amore
princess-cadance
princess-celestia
princess-erroria
princess-golden-dream
princess-luna
princess-platinum
prism-glider
private-pansy
professor-flintheart
professor-fossil
professorbill-neigh
pumpkin-cake
pumpkin-tart
puppydog-tails
purple-haze
purple-polish
purple-stuff
purple-wave
purpletastic-purpleskies
pursey-pink
pushy-ponyturf
q-t-prism
quake
quarter-hearts
queen-cleopatrot
queen-haven
quibble-pants
quiet-gestures
rachel-hay
radiance
raggedy-doctor
ragtime
rain-dance
rainberry
rainbow-blaze
rainbow-dash
rainbow-drop
rainbow-harmony
rainbow-stars
rainbow-swoop
rainbowshine
rainy-day
rainy-feather
ramal-kthyb
randolph
random-ponysunset-bliss
rapid-rush
rapidfire
rare-find
rarity
raritys-dadhondo-flanks
raritys-momcookie-crumbles
raspberry-glaze
raven-inkwell
ray-stinger
record-high
red-delicious
red-gala
red-june
red-rose
redwood-oak
reflective-rock
regal-candent
registration-ponyjanine-manewitz
reporter-ponysnappy-scoop
rhythm-night-shade
riverdance
rivet
rockhoof
rocky-storm
rococo-froufrou
roger-silvermane
rogue-ruby
rolling-thunder
roma
rookie-archaeologistgentiana
rooks-rampart
rose
rose-quartz
rosemary
rosetta
rosewing
rosewood-brook
rosy-posy
rosy-riveter
rough-tumble
roxie-rave
royal-blue
royal-pin
royal-ribbon
royal-riff
rubinstein
ruby-pinch
ruby-splash
ruddy-sparks
rumble
runway-modelchic-flower
rusty-bucket
rusty-tenure
sable-spirit
sad-delegatefluffy-clouds
saddle-arabian-mareamira
saddle-arabian-stallionhaakim
saddle-rager
saffron-masala
salesponyjasmine-leaf
salt-water
sand-arrow
sand-trap
sandbar
sandbars-dadbeachcomber
sandbars-momhigh-tide
sandbars-sistercoral-currents
sandstorm
sans-smirk
sapphire-joy
sapphire-rose
sapphire-shores
sassaflash
sassy-saddles
saturnalia
savannah-guthrie
savoir-fare
say-cheese
scootaloo
score
scouter
screwball
screwy
sea-spray-dubious-discuss
sea-swirl
sealed-scroll
seasong
security-guardlockdown
seedsman-hooffield
senior-deputyfetter-keys
serena
serene-dignitaryimmemoria
serenity
shadow-spade
shady-blues
shady-schoolponyshady-daze
shamrock
sherbet-sunset
sheriff-silverstar
shimmy-shake
shining-armor
shiny-pear
shoeshine
shooting-star
shopkeeperburlap
shortround
shrimp-cuisine
shutter-snap
sightseer
silent-magician-ponyjosehoof-teller
silver-berry
silver-frames
silver-script
silver-shill
silver-spanner
silver-spoon
silver-zoom
silverspeed
silverwing
sincere-friendship-studenthyper-sonic
sir-fluffingsworth-von-radishfield
sir-pony-moore
skeedaddle
skeptical-magician-ponyprance-jillette
skid-marks
sky-flower
sky-stinger
sky-sweeper
sky-view
skyra
slapshot
slate-sentiments
slate-stone
sleek-ponyever-essence
slendermane
slick-waiter-ponypristine
slipstream
smallfry
smart-cookie
smash-fortune
smiley-fanstrawberry-parchment
smiley-resortgoerdusty-swift
smiley-somnambulannile-faras
smiley-star
smokestack
smug-bullydumb-bell
snails
snake-charming-coltcucumber-seed
snap-shutter
snappy-scoop
snide-bullyscore
snips
snobbish-waiter-ponyport-wine
snooty-fashion-scenestervalley-trend
snow-violet
snowdash
snowfall-frost
snowslide
soarin
soft-spot
soigne-folio
soldierneon-brush
somnambula
songbird-serenade
songbird-serenades-agentvinny
songbird-serenades-bodyguardwhinnyfield
soot-stain
sour-drops
sourpuss
sousaphonist-ponyhill-song
south-pole
soybean-sorbet
spa-workerbirch-bucket
spaceage-sparkle
special-delivery
spellbound
spiral-notepad
spitfire
spoiled-rich
sprig-hooffield
spring-forward
spring-fresh
spring-harvest
spring-skies
spring-water
sprinkle-medley
sprout-greenhoof
spur
squeaky-clean
stage-managerback-stage
stage-tales
star-bright
star-dream-sky-dream
star-gazer
star-hunter
star-swirl-the-bearded
star-tracker
starburst
starlight-glimmer
starry-eyes
starstreak
steam-roller
steel-bolts
steel-wright
steeplechase
stella-lashes
stellar-eclipse
stellar-flare
stinkin-rich
stormbreaker
stormfeather
stormy-flare
strawberry-cream
strawberry-ice
strawberry-lime
strawberry-scoop
strawberry-sunrise
street-merchantstinky-bottom
strong-schoolponylily-longsocks
stubborn-crystal-ponytough-nut
student-1polo-play
stuffy-dignitarycommander-redfeather
stygian
stylish-fanlove-sketch
sugar-apple
sugar-belle
sugar-glass
sugar-maple
sugar-plum
sugar-stix
sugar-twist
sugarberry
sugarshine
sun-chaser
sun-glimmer
sun-streak
sunburst
sundowner
sunfire
sunlight
sunny-appleloosanapple-cherry
sunny-daze
sunny-delivery
sunny-rays
sunny-skies
sunny-skies-father
sunny-smiles
sunset-dawn
sunset-rain
sunset-shimmer
sunshine-petals
sunshine-splash
sunshower
sunshower-raindrops
sunspot
sunstone
super-stream
surf
suri-polomare
surprise
surrealist-ponysaddledor-dali
svengallop
swan-song
swanky-hank
sweet-biscuit
sweet-buzz
sweet-dreams
sweet-pop
sweet-service
sweet-toothed-schoolponygallop-j-fry
sweetberry
sweetie-belle
sweetie-drops
sweets-pop
swirly-cotton
swooning-pony-1swoon-song
swooning-pony-2fond-feather
take-off
tall-order
tall-tale
tangerine-glamour
tangerine-tassels
tangerine-twist
tarantella
tatterdemalion-hooffield
teachers-pettruffle
teeny-steps
tempest-shadow
temple-chant
tender-taps
the-great-and-powerful-trixie
the-headless-horse
the-inquisitor
the-olden-pony
the-tenth-doctor-doctor-whooves-3
the-unconditioner
theodore-donald-donny-kerabatsos
thorn
thunder-dust
thunder-flap
thunderlane
thunderstruck-dubious-discuss
ticket-taker-ponyloose-tracks
tiger-lily
tight-ship
timekeeper-ponymedallion-gold
titania
toastie
toe-tapper
toffee
toola-roola
top-marks
torch-song
tornado-bolt
torque-wrench
tough-love
train-conductorsteamer
train-tracks
trainer-1roar-horn
trainer-2sprigfield
traveling-gentlecoltneighl-page
traveling-marecathy-omara
traveling-ponyreal-article
treasure
tree-h-hooffield
tree-hugger
tree-sap
trenderhoof
trendy-backup-dancerstereo-mix
trendy-choreographerglamour-trot
trendy-coiffure
trendy-hype-ponysmooth-vibes
trendy-photographer-ponysnapshot
trim-eea-officialrosy-pearl
trixie
tropical-dream
tropical-spring
tropical-storm
trouble-shoes
trout-pony
trowel-hooffield
trusty-splendor
turner-mccolt
turquoise-harp
turquoise-thunder
tut-junah
twilight-sky
twilight-sparkle
twilights-dadnight-light
twilights-momtwilight-velvet
twinkleshine
twist
twisty-pop
two-ton
uncle-orange
undertone
unicorn-painterleonardo-da-brinci
unicorn-royal-guards
upper-crust
upper-east-stride
valor-valentine
vanilla-sweets
vapor-trail
vapors-dadsteer-straight
vapors-momtwirly-whirly
vegemite
vellum-codex
velvet-light
verity-lucky
vermilion-spring
vidala-swoon
viola
violet-crystal-foalcherry-quartz
violinist-ponysymphony-song
violist-ponywolfgang-canter
wacky-hair-day-and-spray
waltzer
warm-front
water-spout
watermelon-shimmer
wave-chill
wavy-haired-pegasusthe-tenth-doctor-doctor-whooves-3
waxton
wedding-guest-ponydark-moon
welch-cloudy-haze
well-dressed-somnambulancleo-saraj
welly
wensley
wetzel
whinnyapolis-delegatemarch-gustysnows
whiplash
whirlwind-romance
white-crystal-foalfrosty-quartz
white-lightning
white-marble
whitewash
wide-eyed-villagerivy-vine
wild-fire
wildwood-flower
wilma
wind-chill
wind-rider
wind-sprint
wind-waker
windy-whistles
wing-wishes
winnie-waltz
winnow-wind
winsome-schoolponyruby-pinch
winter-lotus
winter-withers
wisp
wrangler
written-script
wylin-slobinzki
yellow-crystal-ponyscarlet-heart
yona
yuma-spurs
zapp
zephyr-breeze
zesty
zesty-gourmand
zipporwhill
zirconic
zoom-zephyrwing`.trim().split('\n');

const SCM_TOOLKIT_PONY_BRANCH_NAMES = [
    ...SCM_TOOLKIT_G4_PONY_BRANCH_NAMES,
    // Main G5 cast
    'sunny-starscout', 'izzy-moonbow', 'hitch-trailblazer',
    'pipp-petals', 'zipp-storm', 'misty-brightdawn',

    // Tamers12345 continuity and variants
    'flawless-sparklemoon', 'apple-bottom', 'apple-split', 'care-package',
    'jinx', 'clean-sweep', 'future-soarin', 'friendship', 'arinos',
    'dazzle-feather', 'skye-silver', 'parcelcore', 'professor-kirin',
    'bobby-moonbeam', 'professor-majorchord', 'astro-novalite',

    // Fanmade characters used by PrinceWhateverer songs
    'sweetie-bot', 'retro-city', 'felix', 'normal-oc', 'bad-oc',

    // Well-known fandom OCs and fan characters
    'apogee', 'snowdrop', 'nyx', 'fluffle-puff', 'button-mash', 'celestai',
    'turing-test', 'flower', 'cleverpony', 'gears', 'applebloom-bot',
    'scoota-bot', 'flawless',

    // Fallout: Equestria and major side-story continuities
    'littlepip', 'velvet-remedy', 'calamity', 'homage', 'steelhooves',
    'red-eye', 'xenith', 'blackjack', 'p-21', 'morning-glory', 'rampage',
    'lacunae', 'scotch-tape', 'boo', 'stygius', 'goldenblood', 'psychoshy',
    'bottlecap', 'puppysmiles', 'better-days', 'hired-gun', 'silver-storm',
    'curly-fries', 'murky-number-seven', 'brimstone-blitz', 'coral-eve',
    'glimmerlight', 'protege', 'wicked-slit', 'sundial', 'caduceus',
    'cayenne', 'silver-heart', 'harmony', 'atom-smasher', 'aurora-borealis',
    'backlash', 'brass-tacks', 'cherry-smiles', 'crossed-wires',
    'cinder-trails', 'cobalt', 'airborne', 'amber-glow', 'aqua-breeze',
    'arc-light', 'aroma', 'arsenal'
];

function scmToolkitPickPonyBranchName(refs, remote) {
    const localPrefix = 'refs/heads/';
    const remotePrefix = `refs/remotes/${remote}/`;
    const used = new Set();

    for (const ref of refs) {
        const id = String(ref?.id ?? '');
        if (id.startsWith(localPrefix)) used.add(id.slice(localPrefix.length));
        if (id.startsWith(remotePrefix)) used.add(id.slice(remotePrefix.length));
    }

    const available = SCM_TOOLKIT_PONY_BRANCH_NAMES.filter(name => !used.has(name));
    if (available.length === 0) return undefined;
    return available[Math.floor(Math.random() * available.length)];
}

async function scmToolkitPushWithPullRetry(repository, originalPush) {
    try {
        await originalPush.call(repository);
    } catch (error) {
        if (
            error?.gitErrorCode !== 'PushRejected'
            || typeof repository.pull !== 'function'
        ) {
            throw error;
        }

        await repository.pull();
        await originalPush.call(repository);
    }
}

function scmToolkitReleaseCommitBeforePush(repository, configuration, notifications) {
    if (
        !repository
        || typeof repository.commit !== 'function'
        || typeof repository.push !== 'function'
    ) {
        return;
    }

    const wrappedRepositories =
        globalThis.__scmToolkitAsyncPushRepositories ??= new WeakMap();
    let state = wrappedRepositories.get(repository);

    if (!state) {
        const originalCommit = repository.commit;
        const originalPush = repository.push;

        const wrappedCommit = async function(message, options) {
            const requestedPostCommitCommand = options?.postCommitCommand;
            const configuredPostCommitCommand =
                configuration.getValue('git.postCommitCommand');
            const shouldReleasePush =
                requestedPostCommitCommand === 'push'
                || (
                    requestedPostCommitCommand === undefined
                    && configuredPostCommitCommand === 'push'
                );

            if (!shouldReleasePush) {
                return originalCommit.call(repository, message, options);
            }

            await originalCommit.call(repository, message, {
                ...(options ?? {}),
                postCommitCommand: null,
            });

            void scmToolkitPushWithPullRetry(repository, originalPush)
                .catch(error => notifications.error(error));
        };

        state = {
            references: 0,
            originalCommit,
            wrappedCommit,
        };
        repository.commit = wrappedCommit;
        wrappedRepositories.set(repository, state);
    }

    state.references += 1;
    let disposed = false;

    return {
        dispose() {
            if (disposed) return;
            disposed = true;
            state.references -= 1;
            if (state.references !== 0) return;

            if (repository.commit === state.wrappedCommit) {
                repository.commit = state.originalCommit;
            }
            wrappedRepositories.delete(repository);
        }
    };
}

function scmToolkitCreateControls(widget, observe, commands, notifications, configuration, mcpService, settings) {
    const doc = widget.element.ownerDocument;
    if (settings.hideOutgoingSyncCount) scmToolkitHideOutgoingSyncCount(widget);
    const branchButton = doc.createElement('button');
    branchButton.type = 'button';
    branchButton.className = 'scm-toolkit-branch';
    branchButton.hidden = true;

    const branchLabel = doc.createElement('span');
    branchLabel.className = 'scm-toolkit-branch-label';

    const arrow = doc.createElement('span');
    arrow.textContent = '▾';
    arrow.setAttribute('aria-hidden', 'true');

    branchButton.append(branchLabel, arrow);

    const pushControl = doc.createElement('label');
    pushControl.className = 'scm-toolkit-push';
    pushControl.hidden = true;
    pushControl.title = 'Commit and push after a successful commit';

    const pushCheckbox = doc.createElement('input');
    pushCheckbox.type = 'checkbox';
    pushCheckbox.className = 'scm-toolkit-push-checkbox';
    pushCheckbox.setAttribute('aria-label', 'Commit and push');

    const pushMark = doc.createElement('span');
    pushMark.className = 'scm-toolkit-push-mark';
    pushMark.setAttribute('aria-hidden', 'true');

    pushControl.append(pushCheckbox, pushMark);

    const syncButton = doc.createElement('button');
    syncButton.type = 'button';
    syncButton.className = 'scm-toolkit-sync-branch codicon codicon-sync';
    syncButton.hidden = true;

    const deleteButton = doc.createElement('button');
    deleteButton.type = 'button';
    deleteButton.className = 'scm-toolkit-delete-branch codicon codicon-trash';
    deleteButton.hidden = true;

    const deleteTooltip = doc.createElement('span');
    deleteTooltip.className = 'scm-toolkit-tooltip';
    deleteTooltip.setAttribute('aria-hidden', 'true');
    deleteButton.append(deleteTooltip);

    const autocompleteButton = doc.createElement('button');
    autocompleteButton.type = 'button';
    autocompleteButton.className = 'scm-toolkit-autocomplete codicon codicon-sparkle';
    autocompleteButton.hidden = true;

    const autocompleteTooltip = doc.createElement('span');
    autocompleteTooltip.className = 'scm-toolkit-tooltip';
    autocompleteTooltip.setAttribute('aria-hidden', 'true');
    autocompleteButton.append(autocompleteTooltip);

    const codexButton = doc.createElement('button');
    codexButton.type = 'button';
    codexButton.className = 'scm-toolkit-codex-coauthor codicon codicon-account';
    codexButton.hidden = true;
    codexButton.title = 'Commit with Codex co-author';
    codexButton.setAttribute('aria-label', 'Commit with Codex co-author');

    const pullRequestButton = doc.createElement('button');
    pullRequestButton.type = 'button';
    pullRequestButton.className = 'scm-toolkit-pull-request codicon codicon-git-pull-request';
    pullRequestButton.hidden = true;

    const pullRequestTooltip = doc.createElement('span');
    pullRequestTooltip.className = 'scm-toolkit-tooltip';
    pullRequestTooltip.setAttribute('aria-hidden', 'true');
    pullRequestButton.append(pullRequestTooltip);

    const ponyBranchButton = doc.createElement('button');
    ponyBranchButton.type = 'button';
    ponyBranchButton.className = 'scm-toolkit-pony-branch codicon codicon-git-branch-create';
    ponyBranchButton.hidden = true;

    const ponyBranchTooltip = doc.createElement('span');
    ponyBranchTooltip.className = 'scm-toolkit-tooltip';
    ponyBranchTooltip.setAttribute('aria-hidden', 'true');
    ponyBranchButton.append(ponyBranchTooltip);

    const settingsButton = doc.createElement('button');
    settingsButton.type = 'button';
    settingsButton.className = 'scm-toolkit-settings codicon codicon-gear';
    settingsButton.hidden = true;
    settingsButton.title = 'Open SCM Toolkit settings';
    settingsButton.setAttribute('aria-label', 'Open SCM Toolkit settings');

    widget.element.prepend(branchButton);
    widget.element.append(
        pushControl,
        syncButton,
        deleteButton,
        autocompleteButton,
        codexButton,
        pullRequestButton,
        ponyBranchButton,
        settingsButton
    );

    let currentCommand;
    let currentCommitCommand;
    let currentBranch;
    let currentHistoryProvider;
    let currentRepositoryArgument;
    let currentInput;
    let pending = false;
    let deletingBranch = false;
    let creatingPullRequest = false;
    let creatingPonyBranch = false;
    let updatingPush = false;
    let updatingAutocomplete = false;
    let committingWithCodex = false;

    const refreshPush = () => {
        pushCheckbox.checked = configuration.getValue('git.postCommitCommand') === 'push';
    };

    const changePush = async event => {
        event.stopPropagation();
        if (updatingPush) return;

        updatingPush = true;
        pushCheckbox.disabled = true;
        const enabled = pushCheckbox.checked;
        try {
            await configuration.updateValue(
                'git.postCommitCommand',
                enabled ? 'push' : 'none'
            );
        } catch (error) {
            notifications.error(error);
        } finally {
            updatingPush = false;
            pushCheckbox.disabled = deletingBranch;
            refreshPush();
        }
    };

    pushCheckbox.addEventListener('change', changePush);
    widget.disposables.add(configuration.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('git.postCommitCommand')) refreshPush();
    }));

    const refreshAutocomplete = () => {
        const enabled = configuration.getValue('editor.inlineSuggest.enabled') !== false;
        autocompleteButton.classList.toggle('scm-toolkit-autocomplete-off', !enabled);
        autocompleteButton.setAttribute('aria-pressed', String(!enabled));
        const description = enabled
            ? 'Turn off inline autocomplete'
            : 'Turn on inline autocomplete';
        autocompleteButton.setAttribute('aria-label', description);
        autocompleteTooltip.textContent = description;
    };

    const toggleAutocomplete = async event => {
        event.stopPropagation();
        if (updatingAutocomplete) return;

        updatingAutocomplete = true;
        autocompleteButton.disabled = true;
        const enabled = configuration.getValue('editor.inlineSuggest.enabled') !== false;
        try {
            await configuration.updateValue('editor.inlineSuggest.enabled', !enabled);
        } catch (error) {
            notifications.error(error);
        } finally {
            updatingAutocomplete = false;
            autocompleteButton.disabled = false;
            refreshAutocomplete();
        }
    };

    autocompleteButton.addEventListener('click', toggleAutocomplete);
    widget.disposables.add(configuration.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('editor.inlineSuggest.enabled')) {
            refreshAutocomplete();
        }
    }));

    const refreshCodexCommit = () => {
        codexButton.disabled =
            pending
            || deletingBranch
            || committingWithCodex
            || !currentInput
            || !currentCommitCommand?.id;
    };

    const commitWithCodex = async event => {
        event.stopPropagation();
        if (
            !settings.codexCoauthor
            || !currentInput
            || !currentCommitCommand?.id
            || pending
            || deletingBranch
            || committingWithCodex
        ) {
            return;
        }

        const originalMessage = currentInput.value ?? '';
        if (!originalMessage.trim()) {
            notifications.error('Enter a commit message before committing with Codex attribution.');
            return;
        }

        const attributedMessage = scmToolkitWithCodexCoauthor(originalMessage);
        committingWithCodex = true;
        refreshCodexCommit();
        currentInput.value = attributedMessage;

        try {
            await commands.executeCommand(
                currentCommitCommand.id,
                ...(currentCommitCommand.arguments ?? [])
            );
        } catch (error) {
            notifications.error(error);
        } finally {
            if (currentInput?.value === attributedMessage) {
                currentInput.value = originalMessage;
            }
            committingWithCodex = false;
            refreshCodexCommit();
        }
    };

    const refreshPullRequest = () => {
        const branch = currentBranch;
        const unavailable =
            !settings.mcpPullRequest
            || !branch
            || branch === settings.defaultBranch
            || !currentRepositoryArgument;

        pullRequestButton.hidden = !settings.mcpPullRequest;
        pullRequestButton.disabled =
            pending || deletingBranch || creatingPullRequest || creatingPonyBranch || unavailable;

        if (!branch) {
            pullRequestTooltip.textContent = 'Open a pull request for the current branch';
        } else if (branch === settings.defaultBranch) {
            pullRequestTooltip.textContent =
                `${settings.defaultBranch} is the pull-request base branch`;
        } else {
            pullRequestTooltip.textContent =
                `Open a pull request for ${branch} with ${settings.mcpPrServer}`;
        }
        pullRequestButton.setAttribute('aria-label', pullRequestTooltip.textContent);
    };

    const createPullRequest = async event => {
        event.stopPropagation();

        const branch = currentBranch;
        const repository = currentRepositoryArgument;
        if (
            !settings.mcpPullRequest
            || !branch
            || branch === settings.defaultBranch
            || !repository
            || pending
            || deletingBranch
            || creatingPullRequest
            || creatingPonyBranch
        ) {
            return;
        }

        const remote = repository.state?.remotes?.find(
            candidate => candidate.name === settings.remote
        );
        const github = scmToolkitParseGitHubRemote(remote?.pushUrl || remote?.fetchUrl);
        if (!github) {
            notifications.error(
                `Cannot create a pull request: ${settings.remote} is not a GitHub remote.`
            );
            return;
        }

        try {
            await mcpService.activateCollections();
        } catch (error) {
            notifications.error(error);
            return;
        }

        const wantedServer = String(settings.mcpPrServer).toLowerCase();
        const server = mcpService.servers.get().find(candidate => {
            const metadata = candidate.serverMetadata?.get?.();
            return [
                candidate.definition?.id,
                candidate.definition?.label,
                metadata?.serverName,
            ].some(name => String(name ?? '').toLowerCase() === wantedServer);
        });
        if (!server) {
            notifications.error(
                `MCP server "${settings.mcpPrServer}" is not configured in VS Code.`
            );
            return;
        }

        creatingPullRequest = true;
        refreshBranchControls();
        try {
            await server.start({ promptType: 'all-untrusted' });
            const tool = await scmToolkitWaitForMcpTool(doc, server, settings.mcpPrTool);
            if (!tool) {
                throw new Error(
                    `MCP tool "${settings.mcpPrTool}" was not found on ${settings.mcpPrServer}.`
                );
            }

            const result = await tool.call({
                owner: github.owner,
                repo: github.repo,
                title: scmToolkitPullRequestTitle(branch),
                prompt: `Open a pull request for branch ${branch}.`,
                body: `Opens \`${branch}\` against \`${settings.defaultBranch}\`.`,
                head: branch,
                base: settings.defaultBranch,
            });
            if (result?.isError) throw new Error(scmToolkitMcpError(result));

            const url = result?.structuredContent?.url;
            notifications.info(
                url
                    ? `Created pull request: ${url}`
                    : `Created pull request for ${branch}.`
            );
        } catch (error) {
            notifications.error(error);
        } finally {
            creatingPullRequest = false;
            refreshBranchControls();
        }
    };

    const refreshPonyBranch = () => {
        const unavailable = !settings.ponyBranch || !currentRepositoryArgument || !currentHistoryProvider;
        ponyBranchButton.hidden = !settings.ponyBranch;
        ponyBranchButton.disabled =
            pending
            || deletingBranch
            || creatingPullRequest
            || creatingPonyBranch
            || unavailable;

        const description =
            `Sync ${settings.defaultBranch} with ${settings.remote} and create a random pony branch`;
        ponyBranchButton.setAttribute('aria-label', description);
        ponyBranchTooltip.textContent = description;
    };

    const createPonyBranch = async event => {
        event.stopPropagation();

        const repository = currentRepositoryArgument;
        const historyProvider = currentHistoryProvider;
        if (
            !settings.ponyBranch
            || !repository
            || !historyProvider
            || pending
            || deletingBranch
            || creatingPullRequest
            || creatingPonyBranch
        ) {
            return;
        }

        creatingPonyBranch = true;
        pushCheckbox.disabled = true;
        refreshBranchControls();

        try {
            await commands.executeCommand('git.checkout', repository, settings.defaultBranch);
            await commands.executeCommand('git.sync', repository);

            const refs = await historyProvider.provideHistoryItemRefs([
                'refs/heads',
                `refs/remotes/${settings.remote}`,
            ]);
            const branchName = scmToolkitPickPonyBranchName(
                Array.isArray(refs) ? refs : [],
                settings.remote
            );
            if (!branchName) {
                notifications.error('All configured pony branch names are already in use.');
                return;
            }

            if (typeof repository.branch !== 'function') {
                throw new Error('The current VS Code Git repository cannot create branches directly.');
            }

            await repository.branch(branchName, true, 'HEAD');
            notifications.info(`Created and switched to ${branchName}.`);
        } catch (error) {
            notifications.error(error);
        } finally {
            creatingPonyBranch = false;
            pushCheckbox.disabled = updatingPush;
            refreshBranchControls();
        }
    };

    const refreshSyncBranch = () => {
        const branch = currentBranch;
        const repository = currentRepositoryArgument;
        syncButton.hidden = !branch;
        syncButton.disabled =
            pending
            || deletingBranch
            || creatingPullRequest
            || creatingPonyBranch
            || !repository
            || typeof repository.fetch !== 'function'
            || typeof repository.merge !== 'function'
            || branch === settings.defaultBranch;

        const description = branch === settings.defaultBranch
            ? `${settings.defaultBranch} is the sync base branch`
            : `Sync ${branch ?? 'current branch'} with ${settings.remote}/${settings.defaultBranch}`;
        syncButton.title = description;
        syncButton.setAttribute('aria-label', description);
    };

    const syncBranch = async event => {
        event.stopPropagation();

        const branch = currentBranch;
        const repository = currentRepositoryArgument;
        const input = currentInput;
        if (
            !branch
            || branch === settings.defaultBranch
            || !repository
            || !input
            || typeof repository.fetch !== 'function'
            || typeof repository.merge !== 'function'
            || pending
            || deletingBranch
            || creatingPullRequest
            || creatingPonyBranch
        ) {
            return;
        }

        pending = true;
        pushCheckbox.disabled = true;
        refreshBranchControls();

        const previousMessage = input.value ?? '';
        try {
            await repository.fetch({ remote: settings.remote });
            input.value = '🔄 Sync brach to main';
            await repository.merge(`${settings.remote}/${settings.defaultBranch}`);

            if (input.value === '🔄 Sync brach to main') {
                input.value = previousMessage;
            }
            notifications.info(`Synced ${branch} with ${settings.defaultBranch}.`);
        } catch (error) {
            // Leave merge conflicts untouched and keep the sync message for the manual commit.
            notifications.error(error);
        } finally {
            pending = false;
            pushCheckbox.disabled = updatingPush || deletingBranch;
            refreshBranchControls();
        }
    };

    const refreshBranchControls = () => {
        branchButton.disabled =
            pending || deletingBranch || creatingPullRequest || creatingPonyBranch || !currentCommand?.id;

        const unavailable =
            !settings.branchCleanup
            || !currentBranch
            || !currentHistoryProvider
            || !currentRepositoryArgument;

        deleteButton.hidden = !settings.branchCleanup || !currentBranch;
        deleteButton.disabled =
            pending
            || deletingBranch
            || creatingPullRequest
            || creatingPonyBranch
            || unavailable
            || currentBranch === settings.defaultBranch;

        if (!currentBranch) {
            deleteButton.removeAttribute('aria-label');
            deleteTooltip.textContent = '';
        } else if (currentBranch === settings.defaultBranch) {
            const description = `${settings.defaultBranch} cannot be deleted`;
            deleteButton.setAttribute('aria-label', description);
            deleteTooltip.textContent = description;
        } else {
            const description =
                `Delete local branch ${currentBranch} if it no longer exists on ${settings.remote}`;
            deleteButton.setAttribute('aria-label', description);
            deleteTooltip.textContent = description;
        }

        refreshSyncBranch();
        refreshCodexCommit();
        refreshPullRequest();
        refreshPonyBranch();
    };

    const openBranchPicker = async event => {
        event.stopPropagation();
        const command = currentCommand;
        if (!command?.id || pending || deletingBranch || creatingPullRequest || creatingPonyBranch) return;

        pending = true;
        refreshBranchControls();
        try {
            await commands.executeCommand(command.id, ...(command.arguments ?? []));
        } catch (error) {
            notifications.error(error);
        } finally {
            pending = false;
            refreshBranchControls();
        }
    };

    const deleteBranch = async event => {
        event.stopPropagation();

        const branch = currentBranch;
        const historyProvider = currentHistoryProvider;
        const repositoryArgument = currentRepositoryArgument;

        if (
            !settings.branchCleanup
            || !branch
            || !historyProvider
            || !repositoryArgument
            || deletingBranch
            || creatingPullRequest
            || creatingPonyBranch
            || pending
        ) {
            return;
        }

        if (branch === settings.defaultBranch) {
            notifications.error(`Cannot delete ${settings.defaultBranch}.`);
            return;
        }

        deletingBranch = true;
        pushCheckbox.disabled = true;
        refreshBranchControls();

        try {
            await commands.executeCommand('git.fetchPrune', repositoryArgument);

            const remotePrefix = `refs/remotes/${settings.remote}`;
            const remoteRefs = await historyProvider.provideHistoryItemRefs([remotePrefix]);

            if (!Array.isArray(remoteRefs) || remoteRefs.length === 0) {
                notifications.error(
                    `Cannot delete ${branch}: ${settings.remote} could not be verified.`
                );
                return;
            }

            if (remoteRefs.some(ref => ref.id === `${remotePrefix}/${branch}`)) {
                notifications.error(
                    `Cannot delete ${branch}: it still exists on ${settings.remote}.`
                );
                return;
            }

            await commands.executeCommand(
                'git.checkout',
                repositoryArgument,
                settings.defaultBranch
            );
            await commands.executeCommand('git.deleteBranch', repositoryArgument, branch);
            await commands.executeCommand('git.sync', repositoryArgument);
        } catch (error) {
            notifications.error(error);
        } finally {
            deletingBranch = false;
            pushCheckbox.disabled = updatingPush;
            refreshBranchControls();
        }
    };

    const openSettings = async event => {
        event.stopPropagation();
        try {
            await commands.executeCommand('scmToolkit.openSettings');
        } catch (error) {
            notifications.error(error);
        }
    };

    branchButton.addEventListener('click', openBranchPicker);
    syncButton.addEventListener('click', syncBranch);
    deleteButton.addEventListener('click', deleteBranch);
    codexButton.addEventListener('click', commitWithCodex);
    pullRequestButton.addEventListener('click', createPullRequest);
    ponyBranchButton.addEventListener('click', createPonyBranch);
    settingsButton.addEventListener('click', openSettings);
    widget.disposables.add({
        dispose() {
            branchButton.removeEventListener('click', openBranchPicker);
            syncButton.removeEventListener('click', syncBranch);
            deleteButton.removeEventListener('click', deleteBranch);
            pushCheckbox.removeEventListener('change', changePush);
            autocompleteButton.removeEventListener('click', toggleAutocomplete);
            codexButton.removeEventListener('click', commitWithCodex);
            pullRequestButton.removeEventListener('click', createPullRequest);
            ponyBranchButton.removeEventListener('click', createPonyBranch);
            settingsButton.removeEventListener('click', openSettings);
            branchButton.remove();
            pushControl.remove();
            syncButton.remove();
            deleteButton.remove();
            autocompleteButton.remove();
            codexButton.remove();
            pullRequestButton.remove();
            ponyBranchButton.remove();
            settingsButton.remove();
        }
    });

    return {
        width() {
            const branchWidth = branchButton.hidden
                ? 0
                : branchButton.getBoundingClientRect().width;
            const pushWidth = pushControl.hidden
                ? 0
                : pushControl.getBoundingClientRect().width;
            const syncWidth = syncButton.hidden
                ? 0
                : syncButton.getBoundingClientRect().width;
            const deleteWidth = deleteButton.hidden
                ? 0
                : deleteButton.getBoundingClientRect().width;
            const autocompleteWidth = autocompleteButton.hidden
                ? 0
                : autocompleteButton.getBoundingClientRect().width;
            const codexWidth = codexButton.hidden
                ? 0
                : codexButton.getBoundingClientRect().width;
            const pullRequestWidth = pullRequestButton.hidden
                ? 0
                : pullRequestButton.getBoundingClientRect().width;
            const ponyBranchWidth = ponyBranchButton.hidden
                ? 0
                : ponyBranchButton.getBoundingClientRect().width;
            const settingsWidth = settingsButton.hidden
                ? 0
                : settingsButton.getBoundingClientRect().width;
            return branchWidth + pushWidth + syncWidth + deleteWidth + autocompleteWidth
                + codexWidth + pullRequestWidth + ponyBranchWidth + settingsWidth;
        },

        bind(input) {
            currentCommand = undefined;
            currentCommitCommand = undefined;
            currentBranch = undefined;
            currentHistoryProvider = undefined;
            currentRepositoryArgument = undefined;
            currentInput = undefined;
            branchButton.hidden = true;
            branchButton.disabled = true;
            pushControl.hidden = true;
            syncButton.hidden = true;
            syncButton.disabled = true;
            deleteButton.hidden = true;
            deleteButton.disabled = true;
            autocompleteButton.hidden = true;
            autocompleteButton.disabled = false;
            codexButton.hidden = true;
            codexButton.disabled = true;
            pullRequestButton.hidden = true;
            pullRequestButton.disabled = true;
            ponyBranchButton.hidden = true;
            ponyBranchButton.disabled = true;
            settingsButton.hidden = true;

            if (!input || input.repository.provider.providerId !== 'git') return;
            currentInput = input;
            settingsButton.hidden = false;
            const provider = input.repository.provider;
            currentCommitCommand = provider.acceptInputCommand;

            if (settings.commitAndPush) {
                pushControl.hidden = false;
                refreshPush();
            }

            if (settings.autocompleteToggle) {
                autocompleteButton.hidden = false;
                refreshAutocomplete();
            }

            if (settings.codexCoauthor) {
                codexButton.hidden = false;
                refreshCodexCommit();
            }

            if (settings.mcpPullRequest) {
                pullRequestButton.hidden = false;
                refreshPullRequest();
            }

            if (settings.ponyBranch) {
                ponyBranchButton.hidden = false;
                refreshPonyBranch();
            }

            syncButton.classList.toggle(
                'scm-toolkit-has-following-control',
                !deleteButton.hidden || !autocompleteButton.hidden || !codexButton.hidden
                    || !pullRequestButton.hidden || !ponyBranchButton.hidden || !settingsButton.hidden
            );
            deleteButton.classList.toggle(
                'scm-toolkit-has-following-control',
                !autocompleteButton.hidden || !codexButton.hidden || !pullRequestButton.hidden
                    || !ponyBranchButton.hidden || !settingsButton.hidden
            );
            autocompleteButton.classList.toggle(
                'scm-toolkit-has-following-control',
                !codexButton.hidden || !pullRequestButton.hidden || !ponyBranchButton.hidden
                    || !settingsButton.hidden
            );
            codexButton.classList.toggle(
                'scm-toolkit-has-following-control',
                !pullRequestButton.hidden || !ponyBranchButton.hidden || !settingsButton.hidden
            );
            pullRequestButton.classList.toggle(
                'scm-toolkit-has-following-control',
                !ponyBranchButton.hidden || !settingsButton.hidden
            );
            ponyBranchButton.classList.toggle(
                'scm-toolkit-has-following-control',
                !settingsButton.hidden
            );

            if (settings.shortPlaceholder) {
                const keepMessagePlaceholderShort = () => {
                    if (input.placeholder !== 'Message') input.placeholder = 'Message';
                };
                keepMessagePlaceholderShort();
                widget.repositoryDisposables.add(
                    input.onDidChangePlaceholder(keepMessagePlaceholderShort)
                );
            }

            let blankStateRefreshDisposable;
            widget.repositoryDisposables.add(observe(reader => {
                const items = provider.statusBarCommands.read(reader) ?? [];
                // Keep the first Git status command and its original arguments so the
                // built-in branch picker remains the source of truth.
                const command = items[0];
                currentCommand = command;
                currentRepositoryArgument = command?.arguments?.[0];

                if (
                    settings.commitAndPush
                    && currentRepositoryArgument
                    && !widget.repositoryDisposables.__scmToolkitAsyncPushBound
                ) {
                    const asyncPushDisposable = scmToolkitReleaseCommitBeforePush(
                        currentRepositoryArgument,
                        configuration,
                        notifications
                    );
                    if (asyncPushDisposable) {
                        widget.repositoryDisposables.__scmToolkitAsyncPushBound = true;
                        widget.repositoryDisposables.add(asyncPushDisposable);
                    }
                }

                if (
                    settings.blankStateRefresh
                    && currentRepositoryArgument
                    && !blankStateRefreshDisposable
                ) {
                    blankStateRefreshDisposable = scmToolkitEnableBlankStateRefresh(
                        widget,
                        input,
                        commands,
                        currentRepositoryArgument,
                        settings.autoPullClean
                    );
                    if (blankStateRefreshDisposable) {
                        widget.repositoryDisposables.add(blankStateRefreshDisposable);
                    }
                }

                const historyProvider = provider.historyProvider.read(reader);
                const historyItemRef = historyProvider?.historyItemRef.read(reader);
                currentHistoryProvider = historyProvider;
                currentBranch = historyItemRef?.id?.startsWith('refs/heads/')
                    ? historyItemRef.name
                    : undefined;

                const branch = command?.title?.replace(/\$\([^)]+\)/g, '').trim();
                branchButton.hidden = !settings.branchPicker || !branch;
                branchLabel.textContent = branch ?? '';
                branchButton.title = command?.tooltip || `Select branch: ${branch ?? ''}`;
                branchButton.setAttribute('aria-label', `Select branch, current branch ${branch ?? ''}`);
                refreshBranchControls();
                widget.layout();
            }));
        }
    };
}
