import { Component, Input, OnInit, OnChanges, SimpleChanges } from '@angular/core';
import { FormControl } from '@angular/forms';
import { Router } from '@angular/router';

@Component({
  selector: 'isari-data-table',
  templateUrl: 'data-table.component.html',
  styleUrls: ['data-table.component.css']
})
export class DataTableComponent implements OnInit, OnChanges {
  page: any[];
  itemsPerPage = 10;
  sortedState: { key: string, reverse: boolean } = { key: '', reverse: false };
  unfilteredData: any[];
  loading = true;

  @Input() data: any[];
  @Input() cols: any[];
  @Input() editedId: string;

  constructor(private router: Router) { }

  ngOnInit() {}

  ngOnChanges(changes: SimpleChanges) {
    let navigateToFirstPage = false;
    if (changes['cols'] && this.cols && this.cols.length) {
      // @TODO : destroy old filters ?
      this.cols = this.cols.map(col => {
        let filterControl = new FormControl('');
        filterControl.valueChanges.subscribe(value => {
          this.applyFilter(col.key, value);
        });
        return Object.assign({}, col, { filterControl });
      });
      navigateToFirstPage = true;
    }
    if (changes['data'] && this.data && this.data.length) {
      this.unfilteredData = this.data;
      this.loading = false;
      navigateToFirstPage = true;
    }
    if (navigateToFirstPage) {
      this.calculPage(1);
    }
  }

  pageChanged($event) {
    this.itemsPerPage = $event.itemsPerPage;
    this.calculPage($event.page);
  }

  sortBy(col) {
    // $event.preventDefault();
    this.data.sort(this.dynamicSort(col.key, this.sortedState.key === col.key && !this.sortedState.reverse));
    this.sortedState.reverse = (this.sortedState.key === col.key) ? !this.sortedState.reverse : false;
    this.sortedState.key = col.key;
    this.calculPage(1);
  }

  edit(id) {
    this.editedId = id;
  // je ne sais pas pquoi ça marche pas
  //   this.router.navigate([{ outlets: { editor: [ id ] } }]);
  }

  private applyFilter(key: string, value: string) {
    this.data = this.unfilteredData
      .filter(item => String(item[key]).toLowerCase().indexOf(value.toLowerCase()) !== -1);
    this.calculPage(1);
  }

  private calculPage(page: number) {
    this.page = this.data.slice((page - 1) * this.itemsPerPage, page * this.itemsPerPage);
  }

  private dynamicSort(property, reverse) {
    let sortOrder = reverse ? -1 : 1;
    return function (a, b) {
        let result = (a[property] < b[property]) ? -1 : (a[property] > b[property]) ? 1 : 0;
        return result * sortOrder;
    };
  }

}
