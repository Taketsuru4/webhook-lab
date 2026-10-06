# Ξεκινώντας με το Webhook Lab

Το τοπικό MVP υποστηρίζει παραλαβή, αποθήκευση, προβολή και manual replay σε ενσωματωμένο mock receiver. Όλος ο κώδικας είναι JavaScript. Τα αρχεία `.jsx` είναι JavaScript με σύνταξη JSX για τα React components.

## Εκκίνηση

Άνοιξε terminal στον φάκελο του project:

```sh
npm install
npm run dev
```

Άνοιξε http://localhost:5173 και πάτησε **Send sample event**. Μπορείς να αλλάξεις το JSON πριν το στείλεις. Στη συνέχεια επίλεξε το request στο inbox και δοκίμασε τα tabs Payload, Headers και Raw body.

Το frontend τρέχει στη θύρα 5173 και το API στη 4310. Η βάση αποθηκεύεται στον φάκελο `.data/postgres/`, οπότε τα requests διατηρούνται μετά την επανεκκίνηση.

## Πώς να διαβάσεις τον κώδικα

1. Ξεκίνα από το `server/index.js`: ανοίγει τη βάση και ξεκινάει τον server.
2. Δες το `server/schema.sql` και τα αριθμημένα upgrades στο `server/migrations.js`: `labs` για endpoints, `captured_requests` για captures, `replay_runs` για προσπάθειες και `mock_receivers` / `mock_receipts` για τα πειράματα.
3. Στο `server/app.js`, βρες το route `/hooks/:token`. Διαβάζει bytes, βρίσκει το lab και καλεί το `saveCapture`.
4. Στο `server/capture.js`, δες πώς εξάγουμε `id` και `type` από το JSON και αποθηκεύουμε το body.
5. Στο `web/src/App.jsx`, το React φορτώνει τα δεδομένα από το API και ενημερώνει το inbox κάθε 2.5 δευτερόλεπτα.

## Ένα πείραμα

Στείλε δύο φορές το ίδιο JSON με ίδιο `id`. Θα δεις δύο ξεχωριστά requests με την ένδειξη **Repeated ×2**. Το Lab αποθηκεύει και τα δύο, ώστε να μπορείς να εξετάσεις τι πραγματικά παραδόθηκε.

Το `202` σημαίνει ότι το request αποθηκεύτηκε. Δεν εκτελεί πληρωμές.

Επίλεξε το capture και πάτησε **Replay original body**. Τα αρχικά bytes στέλνονται με πραγματικό HTTP στον mock receiver. Κάθε πάτημα δημιουργεί ξεχωριστή προσπάθεια με status, διάρκεια και response.

Στο **Receiver behavior**, βάλε **Fail first N requests = 1** και πάτησε **Save & reset receiver**. Κάνε δύο replays: πρώτα θα δεις HTTP 500, μετά HTTP 200. Για timeout, αποθήκευσε delay 3000 ms και κράτησε timeout 2000 ms. Ο receiver μπορεί να έχει ήδη παραλάβει το body όταν σταματήσει να περιμένει ο αποστολέας. Δεν κάνουμε αυτόματο retry.

Το ιστορικό και οι ρυθμίσεις διατηρούνται μετά την επανεκκίνηση. Με **Clear inbox**, πληκτρολόγησε το όνομα του lab για να διαγράψεις τα captures, το replay history και τα mock receipts αυτού του lab. Το endpoint και οι ρυθμίσεις μένουν, ενώ ο μετρητής του receiver μηδενίζεται.

Το `server/replay.js` υλοποιεί τη ροή και το `web/src/ReplayPanel.jsx` τα controls. Δοκίμασε επίσης το **Protect against duplicate demo actions**. Με ενεργή προστασία και ίδιο `id` / ίδια body bytes, δύο replays δίνουν δύο HTTP responses αλλά μόνο μία demo action. Αν αλλάξεις το body κρατώντας το ίδιο ID, ο receiver επιστρέφει 409. Requests χωρίς usable ID επεξεργάζονται χωρίς προστασία. Τα keys μένουν μετά από restart και αλλαγή ρυθμίσεων· το Clear inbox τα διαγράφει.

Οι μετρητές **Demo actions processed**, **Duplicates skipped** και **Key conflicts** δείχνουν τι έγινε στον receiver. Δεν εκτελούνται πραγματικές πληρωμές. Το `server/receiver.js` γράφει receipt, key και demo action μέσα στην ίδια συναλλαγή.

Authentication, arbitrary receiver URLs, Redis/BullMQ και αυτόματα retries μένουν για επόμενο στάδιο.

## Έλεγχοι

```sh
npm run verify
```

Τρέχει lint, tests και production build. Τα tests περιλαμβάνουν ταυτόχρονα duplicates, αποτυχία βάσης και πραγματικό κλείσιμο/επανεκκίνηση της embedded βάσης.

Το project είναι τοπικό και μονοχρηστικό. Χρησιμοποίησε δοκιμαστικά δεδομένα και κράτησε το management API στο localhost.
