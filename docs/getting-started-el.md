# Ξεκινώντας με το Webhook Lab

Αυτή είναι η πρώτη έκδοση: παραλαβή webhook, αποθήκευση και προβολή στο dashboard. Όλος ο κώδικας είναι JavaScript. Τα αρχεία `.jsx` είναι JavaScript με σύνταξη JSX για τα React components.

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
2. Δες το `server/schema.sql`: το `labs` κρατάει τα endpoints, το `captured_requests` κάθε request.
3. Στο `server/app.js`, βρες το route `/hooks/:token`. Διαβάζει bytes, βρίσκει το lab και καλεί το `saveCapture`.
4. Στο `server/capture.js`, δες πώς εξάγουμε `id` και `type` από το JSON και αποθηκεύουμε το body.
5. Στο `web/src/App.jsx`, το React φορτώνει τα δεδομένα από το API και ενημερώνει το inbox κάθε 2.5 δευτερόλεπτα.

## Ένα πείραμα

Στείλε δύο φορές το ίδιο JSON με ίδιο `id`. Θα δεις δύο ξεχωριστά requests με την ένδειξη **Repeated ×2**. Το Lab αποθηκεύει και τα δύο, ώστε να μπορείς να εξετάσεις τι πραγματικά παραδόθηκε.

Το `202` σημαίνει ότι το request αποθηκεύτηκε. Η επόμενη έκδοση θα προσθέσει replay, worker και σενάρια αποτυχίας.

## Έλεγχοι

```sh
npm run verify
```

Τρέχει lint, tests και production build. Τα tests περιλαμβάνουν ταυτόχρονα duplicates, αποτυχία βάσης και πραγματικό κλείσιμο/επανεκκίνηση της embedded βάσης.

Το project είναι τοπικό και μονοχρηστικό. Χρησιμοποίησε δοκιμαστικά δεδομένα και κράτησε το management API στο localhost.
