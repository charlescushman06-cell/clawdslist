/**
 * pages.config.js - Page routing configuration
 * 
 * This file is AUTO-GENERATED. Do not add imports or modify PAGES manually.
 * Pages are auto-registered when you create files in the ./pages/ folder.
 * 
 * THE ONLY EDITABLE VALUE: mainPage
 * This controls which page is the landing page (shown when users visit the app).
 * 
 * Example file structure:
 * 
 *   import HomePage from './pages/HomePage';
 *   import Dashboard from './pages/Dashboard';
 *   import Settings from './pages/Settings';
 *   
 *   export const PAGES = {
 *       "HomePage": HomePage,
 *       "Dashboard": Dashboard,
 *       "Settings": Settings,
 *   }
 *   
 *   export const pagesConfig = {
 *       mainPage: "HomePage",
 *       Pages: PAGES,
 *   };
 * 
 * Example with Layout (wraps all pages):
 *
 *   import Home from './pages/Home';
 *   import Settings from './pages/Settings';
 *   import __Layout from './Layout.jsx';
 *
 *   export const PAGES = {
 *       "Home": Home,
 *       "Settings": Settings,
 *   }
 *
 *   export const pagesConfig = {
 *       mainPage: "Home",
 *       Pages: PAGES,
 *       Layout: __Layout,
 *   };
 *
 * To change the main page from HomePage to Dashboard, use find_replace:
 *   Old: mainPage: "HomePage",
 *   New: mainPage: "Dashboard",
 *
 * The mainPage value must match a key in the PAGES object exactly.
 */
import ApiDocs from './pages/ApiDocs';
import ApiLicense from './pages/ApiLicense';
import BrandUsage from './pages/BrandUsage';
import Copyright from './pages/Copyright';
import Dashboard from './pages/Dashboard';
import Events from './pages/Events';
import Home from './pages/Home';
import HumanPortal from './pages/HumanPortal';
import JournalCorpus from './pages/JournalCorpus';
import ProtocolRevenue from './pages/ProtocolRevenue';
import ReviewQueue from './pages/ReviewQueue';
import Settings from './pages/Settings';
import Submissions from './pages/Submissions';
import Tasks from './pages/Tasks';
import Terms from './pages/Terms';
import Withdrawals from './pages/Withdrawals';
import Workers from './pages/Workers';
import __Layout from './Layout.jsx';


export const PAGES = {
    "ApiDocs": ApiDocs,
    "ApiLicense": ApiLicense,
    "BrandUsage": BrandUsage,
    "Copyright": Copyright,
    "Dashboard": Dashboard,
    "Events": Events,
    "Home": Home,
    "HumanPortal": HumanPortal,
    "JournalCorpus": JournalCorpus,
    "ProtocolRevenue": ProtocolRevenue,
    "ReviewQueue": ReviewQueue,
    "Settings": Settings,
    "Submissions": Submissions,
    "Tasks": Tasks,
    "Terms": Terms,
    "Withdrawals": Withdrawals,
    "Workers": Workers,
}

export const pagesConfig = {
    mainPage: "Home",
    Pages: PAGES,
    Layout: __Layout,
};